import { Controller, Get } from "@nestjs/common";

@Controller()
export class AppController {
  @Get()
  getHome() {
    return {
      status: "ok",
      message: "Telegram Translator Service is running",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("health")
  getHealth() {
    return {
      status: "healthy",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
