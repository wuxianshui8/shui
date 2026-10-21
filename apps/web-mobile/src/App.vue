<script>
export default {
  onLaunch() {
    // eslint-disable-next-line no-console
    console.log("[uni-app] 家教上门撮合平台移动端启动");
  },
};
</script>

<style>
page {
  background: #f5f7fa;
  color: #1f2329;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.wrap { padding: 24rpx; }
.card {
  background: #fff;
  border-radius: 16rpx;
  padding: 24rpx;
  margin-bottom: 20rpx;
  box-shadow: 0 2rpx 12rpx rgba(15, 23, 42, 0.05);
}
.card-title { font-size: 30rpx; font-weight: 600; margin-bottom: 16rpx; }
.kpi { display: flex; flex-wrap: wrap; gap: 16rpx; }
.kpi .item {
  flex: 1 1 45%;
  background: #fff;
  border-radius: 16rpx;
  padding: 20rpx;
  box-shadow: 0 2rpx 12rpx rgba(15, 23, 42, 0.05);
}
.kpi .k { font-size: 22rpx; color: #6b7280; }
.kpi .v { font-size: 34rpx; font-weight: 700; margin-top: 8rpx; }
.muted { color: #6b7280; font-size: 24rpx; }
.row { display: flex; justify-content: space-between; align-items: center; padding: 14rpx 0; border-bottom: 1rpx solid #eef1f5; }
.row:last-child { border-bottom: none; }
.btn {
  background: #1f6feb;
  color: #fff;
  border-radius: 12rpx;
  font-size: 28rpx;
  padding: 18rpx 0;
  text-align: center;
}
.btn.ghost { background: #eef4ff; color: #1f6feb; }
.input {
  background: #f5f7fa;
  border-radius: 12rpx;
  padding: 20rpx;
  font-size: 28rpx;
  margin-bottom: 18rpx;
}
.tag { font-size: 22rpx; padding: 4rpx 12rpx; border-radius: 8rpx; background: #eef4ff; color: #1f6feb; }
</style>
