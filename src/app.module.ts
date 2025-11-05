import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { TelegramService } from "./telegram/telegram.service";
import { OpenAIService } from "./openai/openai.service";
import { TranslatorService } from "./translator/translator.service";

@Module({
  imports: [],
  controllers: [AppController],
  providers: [TelegramService, OpenAIService, TranslatorService],
})
export class AppModule {}
