import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { bad, notFound } from "../common/errors";
import { nowIso } from "../common/reply";
import { resolveRegion } from "../common/geo";

@Injectable()
export class AddressesService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  list(userId: number) {
    return this.ds.query("SELECT * FROM `addresses` WHERE `user_id` = ? ORDER BY `is_default` DESC, `id` DESC", [userId]);
  }

  async create(userId: number, b: any) {
    if (!b.address || !b.contact) throw bad("请填写联系人与详细地址");
    if (b.lat == null || b.lng == null) throw bad("地址需解析定位坐标");
    const region = await resolveRegion(this.ds, Number(b.lat), Number(b.lng));
    const cnt = (await this.ds.query("SELECT COUNT(*) AS c FROM `addresses` WHERE `user_id` = ?", [userId]))[0];
    const isFirst = Number(cnt.c) === 0;
    const r = await this.ds.query(
      "INSERT INTO `addresses` (`user_id`,`label`,`contact`,`phone`,`region_id`,`address`,`lat`,`lng`,`is_default`,`created_at`) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [userId, b.label || "家", b.contact, b.phone || "", region?.id ?? null, b.address, Number(b.lat), Number(b.lng), isFirst || b.isDefault ? 1 : 0, nowIso()],
    );
    if (isFirst || b.isDefault) {
      await this.ds.query("UPDATE `addresses` SET `is_default` = 0 WHERE `user_id` = ? AND `id` <> ?", [userId, r.insertId]);
    }
    return (await this.ds.query("SELECT * FROM `addresses` WHERE `id` = ?", [r.insertId]))[0];
  }

  async update(userId: number, id: number, b: any) {
    const a = (await this.ds.query("SELECT * FROM `addresses` WHERE `id` = ? AND `user_id` = ?", [id, userId]))[0];
    if (!a) throw notFound("地址不存在");
    await this.ds.query(
      "UPDATE `addresses` SET `label`=?, `contact`=?, `phone`=?, `address`=?, `lat`=?, `lng`=? WHERE `id` = ?",
      [b.label ?? a.label, b.contact ?? a.contact, b.phone ?? a.phone, b.address ?? a.address, b.lat != null ? Number(b.lat) : a.lat, b.lng != null ? Number(b.lng) : a.lng, a.id],
    );
    return (await this.ds.query("SELECT * FROM `addresses` WHERE `id` = ?", [a.id]))[0];
  }

  async remove(userId: number, id: number) {
    const a = (await this.ds.query("SELECT * FROM `addresses` WHERE `id` = ? AND `user_id` = ?", [id, userId]))[0];
    if (!a) throw notFound("地址不存在");
    await this.ds.query("DELETE FROM `addresses` WHERE `id` = ?", [a.id]);
    return { ok: true };
  }

  async setDefault(userId: number, id: number) {
    const a = (await this.ds.query("SELECT * FROM `addresses` WHERE `id` = ? AND `user_id` = ?", [id, userId]))[0];
    if (!a) throw notFound("地址不存在");
    await this.ds.query("UPDATE `addresses` SET `is_default` = 0 WHERE `user_id` = ?", [userId]);
    await this.ds.query("UPDATE `addresses` SET `is_default` = 1 WHERE `id` = ?", [a.id]);
    return { ok: true };
  }
}