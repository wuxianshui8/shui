// 客诉工单（家长 / 教员发起，需求 4.x 客服与纠纷）
import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { bad } from "../common/errors";
import { nowIso } from "../common/reply";
import { ok } from "../common/reply";
import { audit, notify } from "../common/audit";

@Controller("complaints")
export class ComplaintController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Post()
  @HttpCode(200)
  async create(@Body() b: any, @Req() req: any) {
    const uid = Number(req.user.uid);
    const title = String(b?.title || "").trim();
    const content = String(b?.content || "").trim();
    if (!title) throw bad("请填写工单标题");
    if (!content) throw bad("请填写问题描述");

    let regionId: number | null = null;
    let orderId: number | null = null;
    if (b?.orderId) {
      const o = (await this.ds.query("SELECT * FROM `orders` WHERE `id` = ? LIMIT 1", [Number(b.orderId)]))[0];
      if (o && (Number(o.parent_id) === uid || Number(o.teacher_id) === uid)) {
        orderId = Number(o.id);
        regionId = o.region_id == null ? null : Number(o.region_id);
      }
    }
    if (regionId == null) {
      const u = (await this.ds.query("SELECT `region_id` FROM `users` WHERE `id` = ? LIMIT 1", [uid]))[0];
      regionId = u?.region_id == null ? null : Number(u.region_id);
    }

    return this.ds.transaction(async (m) => {
      const r = await m.query(
        "INSERT INTO `complaints` (`order_id`,`from_user`,`from_role`,`region_id`,`type`,`title`,`content`,`status`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?)",
        [orderId, uid, req.user.role, regionId, b?.type === "complaint" ? "complaint" : "complaint", title, content, "open", nowIso()],
      );
      for (const a of await m.query("SELECT `id` FROM `users` WHERE `role` = 'admin'")) {
        await notify(m, Number(a.id), "收到客诉工单", title, "risk", "/admin#/risk");
      }
      const agent = regionId
        ? (await m.query("SELECT `user_id` FROM `agent_profiles` WHERE `region_id` = ? AND `status` = 'active' LIMIT 1", [regionId]))[0]
        : null;
      if (agent) await notify(m, Number(agent.user_id), "片区新增客诉工单", title, "risk", "/agent#/complaint");
      await audit(m, { user: req.user, ip: req.ip }, "complaint.create", "complaints:" + r.insertId, { title });
      return (await m.query("SELECT * FROM `complaints` WHERE `id` = ?", [r.insertId]))[0];
    });
  }

  @Get("mine")
  async mine(@Req() req: any) {
    const uid = Number(req.user.uid);
    return ok({
      list: await this.ds.query(
        "SELECT * FROM `complaints` WHERE `from_user` = ? ORDER BY `id` DESC LIMIT 50", [uid],
      ),
    });
  }
}
