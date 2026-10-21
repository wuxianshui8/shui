import { Body, Controller, Delete, Get, Param, Post, Put, Req, HttpCode } from "@nestjs/common";
import { AddressesService } from "./addresses.service";
import { ok } from "./reply";

@Controller("addresses")
export class AddressesController {
  constructor(private readonly svc: AddressesService) {}

  @Get()
  async list(@Req() req: any) {
    return ok(await this.svc.list(req.user.uid));
  }

  @HttpCode(200)

  @Post()
  async create(@Body() body: any, @Req() req: any) {
    return ok(await this.svc.create(req.user.uid, body));
  }

  @Put(":id")
  async update(@Param("id") id: string, @Body() body: any, @Req() req: any) {
    return ok(await this.svc.update(req.user.uid, Number(id), body));
  }

  @Delete(":id")
  async remove(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.remove(req.user.uid, Number(id)));
  }

  @HttpCode(200)

  @Post(":id/default")
  async setDefault(@Param("id") id: string, @Req() req: any) {
    return ok(await this.svc.setDefault(req.user.uid, Number(id)));
  }
}