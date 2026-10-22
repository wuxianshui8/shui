<script setup>
/**
 * 入驻认证（移动端）
 *
 * 与 PC / 参考实现同一套接口契约：
 *   GET  /api/teacher/profile      读已提交资料（含状态、证件图、是否人证一致）
 *   POST /api/upload               base64 图片 → /uploads/xxx
 *   POST /api/teacher/ocr-idcard   上传人像面后即时识别，回显姓名与脱敏号码
 *   POST /api/teacher/apply        提交审核（证件识别结果与填写信息不一致会被服务端拒）
 *
 * 证件照片必须清晰可读：mock 通道按文件名「姓名_身份证号」解析，真实通道（腾讯云）直接识图。
 */
import { computed, onMounted, reactive, ref } from "vue";

const form = reactive({
  identityType: "student",
  realName: "",
  idCard: "",
  intro: "",
  hourlyPrice: "",
  serviceRadiusKm: 5,
  coverArea: "",
  scheduleText: "",
  lat: 30.261,
  lng: 120.132,
  idCardFrontUrl: "",
  idCardBackUrl: "",
  eduCertUrl: "",
  teacherCertUrl: "",
  skillCertUrl: "",
});
const subjects = ref([]);
const stages = ref([]);
const dictSubjects = ref([]);
const dictStages = ref([]);
const submitting = ref(false);
const loading = ref(true);
const status = ref("none"); // none | pending | rejected | approved
const rejectReason = ref("");
const profile = ref(null);
const ocrState = reactive({ busy: false, text: "", ok: null });
const uploading = reactive({ idCardFrontUrl: "", idCardBackUrl: "", eduCertUrl: "", teacherCertUrl: "", skillCertUrl: "" });

const IDENTITY = [
  { value: "student", label: "在校大学生" },
  { value: "in_service", label: "在职教师" },
  { value: "part_time", label: "社会兼职教员" },
];

const editable = computed(() => status.value === "none" || status.value === "rejected");
const statusText = computed(() => ({
  none: "尚未提交入驻资料",
  pending: "资料审核中，请耐心等待",
  rejected: "审核未通过，请修改后重新提交",
  approved: "资质已通过审核",
}[status.value]));

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    uni.request({
      url: "/api" + path,
      method,
      data: body || {},
      header: { Authorization: "Bearer " + uni.getStorageSync("token"), "Content-Type": "application/json" },
      success: (res) => {
        const d = res.data || {};
        if (d.code === 0) resolve(d.data);
        else reject(new Error(d.message || "请求失败"));
      },
      fail: () => reject(new Error("网络异常，请稍后重试")),
    });
  });
}

const toast = (title) => uni.showToast({ title, icon: "none", duration: 2400 });
const money = (c) => "¥" + (Number(c || 0) / 100).toFixed(2);

async function load() {
  loading.value = true;
  try {
    const dict = await req("GET", "/meta/dictionary").catch(() => null);
    dictStages.value = (dict && dict.stages) || [];
    dictSubjects.value = (dict && dict.subjects) || [];
    const d = await req("GET", "/teacher/profile").catch(() => null);
    if (d && d.applied && d.profile) {
      profile.value = d.profile;
      const p = d.profile;
      status.value = p.auditStatus || "pending";
      rejectReason.value = p.rejectReason || "";
      form.identityType = p.identityType || "student";
      form.realName = p.realName || "";
      form.intro = p.intro || "";
      form.hourlyPrice = p.hourlyPrice ? Number(p.hourlyPrice) / 100 : "";
      form.serviceRadiusKm = p.serviceRadiusKm || 5;
      form.coverArea = p.coverArea || "";
      form.lat = p.baseLat || form.lat;
      form.lng = p.baseLng || form.lng;
      form.idCardFrontUrl = p.idCardFrontUrl || "";
      form.idCardBackUrl = p.idCardBackUrl || "";
      form.eduCertUrl = p.eduCertUrl || "";
      form.teacherCertUrl = p.teacherCertUrl || "";
      form.skillCertUrl = p.skillCertUrl || "";
      subjects.value = [...(p.subjects || [])];
      stages.value = [...(p.stages || [])];
      form.scheduleText = (p.schedule || [])
        .map((s) => (s.day || "") + " " + (s.start || "") + "-" + (s.end || ""))
        .join("\n");
    } else {
      status.value = "none";
    }
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const toggle = (list, v) => {
  const i = list.value.indexOf(v);
  if (i >= 0) list.value.splice(i, 1);
  else list.value.push(v);
};

/** 选择图片（优先压缩，超过 2MB 直接拦） */
function chooseImage() {
  return new Promise((resolve) => {
    uni.chooseImage({
      count: 1,
      sizeType: ["compressed"],
      success: (r) => {
        const file = (r.tempFiles && r.tempFiles[0]) || null;
        const path = (r.tempFilePaths && r.tempFilePaths[0]) || "";
        resolve({ file, path });
      },
      fail: () => resolve(null),
    });
  });
}

/**
 * 图片 → dataURL。
 * H5 拿的是 File，用 FileReader；小程序没有 FileReader，用文件系统读 base64 再补 MIME 头。
 */
function toDataUrl(file, path) {
  return new Promise((resolve, reject) => {
    // #ifdef H5
    const f = file && file.raw ? file.raw : file;
    if (f && typeof FileReader !== "undefined" && f instanceof Blob) {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(f);
      return;
    }
    // #endif
    try {
      const fs = uni.getFileSystemManager();
      const base64 = fs.readFileSync(path, "base64");
      const ext = String(path).split(".").pop().toLowerCase();
      const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      resolve("data:" + mime + ";base64," + base64);
    } catch (e) {
      reject(new Error("图片读取失败，请重新选择"));
    }
  });
}

/** 上传某个证件位；人像面额外做一次识别并给出结论 */
async function pickImage(key) {
  if (!editable.value) return;
  const picked = await chooseImage();
  if (!picked) return;
  if (picked.file && picked.file.size && picked.file.size > 2 * 1024 * 1024) {
    return toast("图片不能超过 2MB，请压缩后重试");
  }
  uploading[key] = "上传中…";
  try {
    const dataUrl = await toDataUrl(picked.file, picked.path);
    const original = (picked.file && picked.file.name) || (picked.path ? String(picked.path).split("/").pop() : key);
    const saved = await req("POST", "/upload", { filename: original, dataUrl });
    form[key] = saved.url;
    uploading[key] = "";
    if (key === "idCardFrontUrl") await recognize(saved.url);
    else toast("已上传");
  } catch (e) {
    uploading[key] = "";
    toast(e.message || "上传失败");
  }
}

function removeImage(key) {
  if (!editable.value) return;
  form[key] = "";
  if (key === "idCardFrontUrl") {
    ocrState.text = "";
    ocrState.ok = null;
  }
}

/** 即时识别：让用户在提交前知道证件与填写是否一致 */
async function recognize(url) {
  ocrState.busy = true;
  ocrState.text = "识别中…";
  ocrState.ok = null;
  try {
    const r = await req("POST", "/teacher/ocr-idcard", {
      url,
      realName: String(form.realName || "").trim(),
      idCard: String(form.idCard || "").trim(),
    });
    if (!r || !r.recognized) {
      ocrState.text = (r && r.message) || "证件未能识别，请上传清晰、无反光的人像面";
      ocrState.ok = false;
      return;
    }
    const who = "识别到：" + r.name + " · " + (r.idCardMasked || "");
    ocrState.ok = !!(r.match && r.match.ok);
    ocrState.text = ocrState.ok ? who + "（与填写一致）" : who + "；" + (r.message || "与填写不一致");
  } catch (e) {
    ocrState.text = e.message || "识别失败";
    ocrState.ok = false;
  } finally {
    ocrState.busy = false;
  }
}

/** "周一 09:00-11:00" 每行一条 → [{day,start,end}] */
function parseSchedule(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(\S+)\s+(\d{1,2}:\d{2})\s*[-~]\s*(\d{1,2}:\d{2})$/.exec(line);
      return m ? { day: m[1], start: m[2], end: m[3] } : null;
    })
    .filter(Boolean);
}

async function submit() {
  if (!editable.value) return;
  if (!String(form.realName || "").trim()) return toast("请填写真实姓名（须与身份证一致）");
  if (!/^\d{17}[\dXx]$/.test(String(form.idCard || "").trim())) return toast("身份证号格式不正确");
  if (!form.idCardFrontUrl) return toast("请上传身份证正面（人像面）");
  if (!form.idCardBackUrl) return toast("请上传身份证反面（国徽面）");
  if (!subjects.value.length) return toast("请至少选择一个擅长科目");
  if (!(Number(form.hourlyPrice) > 0)) return toast("请填写课时单价");
  if (ocrState.ok === false) return toast("证件信息与填写不一致，请核对后重试");

  submitting.value = true;
  try {
    await req("POST", "/teacher/apply", {
      identityType: form.identityType,
      realName: String(form.realName).trim(),
      idCard: String(form.idCard).trim(),
      eduCertUrl: form.eduCertUrl || "",
      teacherCertUrl: form.teacherCertUrl || "",
      skillCertUrl: form.skillCertUrl || "",
      idCardFrontUrl: form.idCardFrontUrl,
      idCardBackUrl: form.idCardBackUrl,
      intro: form.intro || "",
      subjects: subjects.value.join(","),
      stages: stages.value.join(","),
      hourlyPrice: Math.round(Number(form.hourlyPrice) * 100),
      serviceRadiusKm: Number(form.serviceRadiusKm) || 5,
      schedule: parseSchedule(form.scheduleText),
      coverArea: form.coverArea || "",
      lat: Number(form.lat),
      lng: Number(form.lng),
    });
    uni.showToast({ title: "已提交审核，请等待平台核验", icon: "none" });
    setTimeout(() => uni.navigateBack(), 900);
  } catch (e) {
    toast(e.message || "提交失败");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <view class="wrap">
    <view class="card">
      <view class="card-title">入驻认证</view>
      <view class="muted">{{ statusText }}</view>
      <view v-if="status === 'rejected' && rejectReason" class="muted" style="margin-top: 8rpx; color: #c02a2a">
        驳回原因：{{ rejectReason }}
      </view>
      <view v-if="profile && profile.idCardVerified" class="tag" style="margin-top: 12rpx; background: #e7f8ee; color: #15803d">
        系统已核：人与证件一致
      </view>
    </view>

    <view class="card">
      <view class="card-title">身份类型</view>
      <view class="row" style="flex-wrap: wrap; gap: 12rpx">
        <view
          v-for="it in IDENTITY"
          :key="it.value"
          class="tag"
          :style="{ background: form.identityType === it.value ? '#1f6feb' : '#eef4ff', color: form.identityType === it.value ? '#fff' : '#1f6feb' }"
          @click="editable && (form.identityType = it.value)"
        >{{ it.label }}</view>
      </view>
    </view>

    <view class="card">
      <view class="card-title">基本资料</view>

      <view class="muted" style="margin-bottom: 10rpx">真实姓名 *</view>
      <input v-model="form.realName" class="input" placeholder="与身份证一致" :disabled="!editable" />

      <view class="muted" style="margin: 18rpx 0 10rpx">身份证号 *</view>
      <input v-model="form.idCard" class="input" maxlength="18" placeholder="18 位身份证号" :disabled="!editable" />
      <view class="muted" style="margin-top: 8rpx">平台不回显已提交的身份证号，重新提交时请再次填写完整号码。</view>

      <!-- 身份证正反面：上传 + 缩略图 + 识别反馈 -->
      <view class="muted" style="margin: 22rpx 0 10rpx">身份证正面（人像面）*</view>
      <view class="uploader">
        <image v-if="form.idCardFrontUrl" class="shot" :src="form.idCardFrontUrl" mode="aspectFill" @click="uni.previewImage({ urls: [form.idCardFrontUrl] })" />
        <view class="pick" @click="pickImage('idCardFrontUrl')">
          <text class="ico">📷</text>
          <text>{{ form.idCardFrontUrl ? "重新上传" : "上传图片" }}</text>
        </view>
        <view v-if="form.idCardFrontUrl" class="tag" style="background: #f4f6fa; color: #666" @click="removeImage('idCardFrontUrl')">删除</view>
      </view>
      <view v-if="uploading.idCardFrontUrl" class="muted">{{ uploading.idCardFrontUrl }}</view>
      <view
        v-if="ocrState.text"
        class="muted"
        :style="{ color: ocrState.ok === true ? '#15803d' : ocrState.ok === false ? '#c02a2a' : '#999' }"
      >{{ ocrState.text }}</view>

      <view class="muted" style="margin: 22rpx 0 10rpx">身份证反面（国徽面）*</view>
      <view class="uploader">
        <image v-if="form.idCardBackUrl" class="shot" :src="form.idCardBackUrl" mode="aspectFill" @click="uni.previewImage({ urls: [form.idCardBackUrl] })" />
        <view class="pick" @click="pickImage('idCardBackUrl')">
          <text class="ico">📷</text>
          <text>{{ form.idCardBackUrl ? "重新上传" : "上传图片" }}</text>
        </view>
        <view v-if="form.idCardBackUrl" class="tag" style="background: #f4f6fa; color: #666" @click="removeImage('idCardBackUrl')">删除</view>
      </view>
      <view v-if="uploading.idCardBackUrl" class="muted">{{ uploading.idCardBackUrl }}</view>

      <!-- 其它证书：可留空 -->
      <template v-for="c in [
        { key: 'eduCertUrl', label: '学历证书' },
        { key: 'teacherCertUrl', label: '教师资格证' },
        { key: 'skillCertUrl', label: '技能证书' },
      ]" :key="c.key">
        <view class="muted" style="margin: 22rpx 0 10rpx">{{ c.label }}（可留空）</view>
        <view class="uploader">
          <image v-if="form[c.key]" class="shot" :src="form[c.key]" mode="aspectFill" @click="uni.previewImage({ urls: [form[c.key]] })" />
          <view class="pick" @click="pickImage(c.key)">
            <text class="ico">📷</text>
            <text>{{ form[c.key] ? "重新上传" : "上传图片" }}</text>
          </view>
          <view v-if="form[c.key]" class="tag" style="background: #f4f6fa; color: #666" @click="removeImage(c.key)">删除</view>
        </view>
        <view v-if="uploading[c.key]" class="muted">{{ uploading[c.key] }}</view>
      </template>

      <view class="muted" style="margin: 22rpx 0 10rpx">自我介绍</view>
      <textarea v-model="form.intro" class="input" style="min-height: 140rpx" placeholder="教学经验、提分案例、教学风格" :disabled="!editable" />

      <view class="muted" style="margin: 22rpx 0 10rpx">擅长科目 *</view>
      <view class="row" style="flex-wrap: wrap; gap: 12rpx">
        <view
          v-for="s in dictSubjects"
          :key="s"
          class="tag"
          :style="{ background: subjects.includes(s) ? '#1f6feb' : '#eef4ff', color: subjects.includes(s) ? '#fff' : '#1f6feb' }"
          @click="editable && toggle(subjects, s)"
        >{{ s }}</view>
      </view>

      <view class="muted" style="margin: 22rpx 0 10rpx">适用学段</view>
      <view class="row" style="flex-wrap: wrap; gap: 12rpx">
        <view
          v-for="s in dictStages"
          :key="s"
          class="tag"
          :style="{ background: stages.includes(s) ? '#1f6feb' : '#eef4ff', color: stages.includes(s) ? '#fff' : '#1f6feb' }"
          @click="editable && toggle(stages, s)"
        >{{ s }}</view>
      </view>

      <view class="muted" style="margin: 22rpx 0 10rpx">课时单价（元）*</view>
      <input v-model="form.hourlyPrice" class="input" type="digit" placeholder="如 200" :disabled="!editable" />

      <view class="muted" style="margin: 22rpx 0 10rpx">服务半径（公里）</view>
      <input v-model="form.serviceRadiusKm" class="input" type="number" placeholder="5" :disabled="!editable" />

      <view class="muted" style="margin: 22rpx 0 10rpx">可授课时间表</view>
      <textarea
        v-model="form.scheduleText"
        class="input"
        style="min-height: 140rpx"
        placeholder="每行一个，如：周一 09:00-11:00"
        :disabled="!editable"
      />

      <view class="muted" style="margin: 22rpx 0 10rpx">覆盖区域描述</view>
      <input v-model="form.coverArea" class="input" placeholder="如 西湖区文三路周边 5 公里" :disabled="!editable" />

      <view class="btn" :class="{ ghost: !editable }" style="margin-top: 26rpx" @click="submit">
        {{ !editable ? statusText : submitting ? "提交中…" : status === "rejected" ? "重新提交审核" : "提交入驻申请" }}
      </view>
      <view class="muted" style="margin-top: 14rpx">
        提交后进入人工审核；证件与证书仅用于平台核验，不对外展示。
      </view>
    </view>
  </view>
</template>

<style scoped>
.uploader { display: flex; align-items: center; gap: 16rpx; flex-wrap: wrap; }
.uploader .shot { width: 168rpx; height: 112rpx; border-radius: 12rpx; background: #f1f4f9; }
.uploader .pick {
  width: 168rpx; height: 112rpx; border-radius: 12rpx; border: 1rpx dashed #c9d3e0; background: #fbfcfe;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6rpx;
  font-size: 22rpx; color: #97a3b6;
}
.uploader .pick .ico { font-size: 34rpx; }
</style>
