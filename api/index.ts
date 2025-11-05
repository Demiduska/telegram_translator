import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { AppModule } from "../src/app.module";
import express from "express";
import * as dotenv from "dotenv";

dotenv.config();

const server = express();
let app: any;

async function createNestApp() {
  if (!app) {
    app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
      logger: ["error", "warn"],
    });
    app.enableCors();
    await app.init();
  }
  return server;
}

export default async (req: any, res: any) => {
  await createNestApp();
  server(req, res);
};
