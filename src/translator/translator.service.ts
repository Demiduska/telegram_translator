import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { TelegramService } from "../telegram/telegram.service";
import { OpenAIService } from "../openai/openai.service";
import { NewMessageEvent } from "telegram/events";
import * as fs from "fs";
import * as path from "path";

interface ChannelConfig {
  sourceId: number;
  targetTopicId: number;
  promptKey: string;
  prompt?: string;
}

@Injectable()
export class TranslatorService implements OnModuleInit {
  private readonly logger = new Logger(TranslatorService.name);
  private targetGroupId: number;
  private channels: ChannelConfig[] = [];
  private prompts: Record<string, string> = {};
  private groupedMessages: Map<
    string,
    { messages: any[]; timeout: NodeJS.Timeout; channelConfig: ChannelConfig }
  > = new Map();
  // Map to store source message ID -> target message ID
  private messageMapping: Map<number, number> = new Map();

  // Legacy mode support
  private sourceChannelId: number;
  private targetChannelId: number;
  private useDirectIds: boolean = false;
  private useLegacyMode: boolean = false;

  constructor(
    private readonly telegramService: TelegramService,
    private readonly openaiService: OpenAIService
  ) {
    this.loadPrompts();
    this.parseChannelConfiguration();
  }

  private loadPrompts() {
    try {
      const promptsPath = path.join(process.cwd(), "prompts.json");
      if (fs.existsSync(promptsPath)) {
        const promptsData = fs.readFileSync(promptsPath, "utf-8");
        this.prompts = JSON.parse(promptsData);
        this.logger.log(
          `Loaded ${Object.keys(this.prompts).length} prompts from prompts.json`
        );
      } else {
        this.logger.warn("prompts.json not found, using default prompts only");
        this.prompts = { default: "" }; // Will use hardcoded default
      }
    } catch (error) {
      this.logger.error("Failed to load prompts.json", error.stack);
      this.prompts = { default: "" };
    }
  }

  private parseChannelConfiguration() {
    const channelsConfig = process.env.CHANNELS_CONFIG;

    if (channelsConfig) {
      // Multi-channel mode
      this.logger.log("Using multi-channel configuration mode");
      const targetGroupId = process.env.TARGET_GROUP_ID;

      if (!targetGroupId) {
        throw new Error(
          "TARGET_GROUP_ID is required when using CHANNELS_CONFIG"
        );
      }

      this.targetGroupId = parseInt(targetGroupId);

      // Parse format: sourceId:topicId:promptKey,sourceId:topicId:promptKey,...
      const channelEntries = channelsConfig.split(",");

      for (const entry of channelEntries) {
        const [sourceId, targetTopicId, promptKey] = entry.split(":");

        if (!sourceId || !targetTopicId || !promptKey) {
          this.logger.warn(`Invalid channel config entry: ${entry}`);
          continue;
        }

        const config: ChannelConfig = {
          sourceId: parseInt(sourceId.trim()),
          targetTopicId: parseInt(targetTopicId.trim()),
          promptKey: promptKey.trim(),
          prompt: this.prompts[promptKey.trim()],
        };

        if (!config.prompt && promptKey !== "default") {
          this.logger.warn(
            `Prompt key '${promptKey}' not found in prompts.json, will use default`
          );
        }

        this.channels.push(config);
        this.logger.log(
          `Configured channel ${config.sourceId} -> topic ${config.targetTopicId} with prompt '${config.promptKey}'`
        );
      }

      if (this.channels.length === 0) {
        throw new Error("No valid channels configured in CHANNELS_CONFIG");
      }
    } else {
      // Legacy single-channel mode
      this.logger.log("Using legacy single-channel mode");
      this.useLegacyMode = true;

      const sourceId = process.env.SOURCE_CHANNEL_ID;
      const targetId = process.env.TARGET_CHANNEL_ID;

      if (sourceId && targetId) {
        this.sourceChannelId = parseInt(sourceId);
        this.targetChannelId = parseInt(targetId);
        this.useDirectIds = true;
        this.logger.log(
          `Using direct channel IDs - Source: ${this.sourceChannelId}, Target: ${this.targetChannelId}`
        );
      }
    }
  }

  async onModuleInit() {
    // Wait for TelegramService to be ready
    await this.telegramService.waitForReady();

    if (this.useLegacyMode) {
      // Only resolve if we don't have direct IDs
      if (!this.useDirectIds) {
        await this.resolveChannelIds();
      }
      this.startWatchingLegacy();
    } else {
      this.startWatchingMultiChannel();
    }
  }

  private async resolveChannelIds() {
    const sourceUrl = process.env.SOURCE_CHANNEL_URL;
    const targetUrl = process.env.TARGET_CHANNEL_URL;

    if (!sourceUrl || !targetUrl) {
      throw new Error(
        "Missing channel configuration. Provide either SOURCE_CHANNEL_ID + TARGET_CHANNEL_ID or SOURCE_CHANNEL_URL + TARGET_CHANNEL_URL in .env"
      );
    }

    this.logger.log("Resolving Telegram channel IDs from URLs...");

    try {
      const sourceEntity: any = await this.telegramService.getEntity(sourceUrl);
      const targetEntity: any = await this.telegramService.getEntity(targetUrl);

      // Extract the actual ID from the entity
      // The entity object structure may vary, so we handle different cases
      this.sourceChannelId = sourceEntity.id?.value
        ? Number(sourceEntity.id.value)
        : Number(sourceEntity.id);

      this.targetChannelId = targetEntity.id?.value
        ? Number(targetEntity.id.value)
        : Number(targetEntity.id);

      this.logger.log(
        `Resolved source channel ID: ${this.sourceChannelId}, target channel ID: ${this.targetChannelId}`
      );
    } catch (error) {
      this.logger.error("Failed to resolve channel IDs", error.stack);
      throw error;
    }
  }

  private startWatchingMultiChannel() {
    this.logger.log(
      `Starting to watch ${this.channels.length} channels for messages...`
    );

    for (const channelConfig of this.channels) {
      this.telegramService.addNewMessageHandler(
        channelConfig.sourceId,
        (event) => this.handleNewMessageMulti(event, channelConfig)
      );

      this.telegramService.addEditedMessageHandler(
        channelConfig.sourceId,
        (event) => this.handleEditedMessageMulti(event, channelConfig)
      );

      this.logger.log(
        `📢 Listening to channel ${channelConfig.sourceId} -> posting to topic ${channelConfig.targetTopicId}`
      );
    }
  }

  private startWatchingLegacy() {
    this.logger.log(
      `Starting to watch channel ${this.sourceChannelId} for messages...`
    );

    this.telegramService.addNewMessageHandler(
      this.sourceChannelId,
      this.handleNewMessage.bind(this)
    );

    this.telegramService.addEditedMessageHandler(
      this.sourceChannelId,
      this.handleEditedMessage.bind(this)
    );
  }

  private async handleNewMessageMulti(
    event: NewMessageEvent,
    channelConfig: ChannelConfig
  ) {
    try {
      const message = event.message;
      const groupedId = (message as any).groupedId?.toString();

      if (groupedId) {
        // This is part of an album - collect all messages before processing
        if (!this.groupedMessages.has(groupedId)) {
          this.groupedMessages.set(groupedId, {
            messages: [],
            timeout: null as any,
            channelConfig,
          });
        }

        const groupData = this.groupedMessages.get(groupedId)!;
        groupData.messages.push(message);

        // Clear existing timeout
        if (groupData.timeout) {
          clearTimeout(groupData.timeout);
        }

        // Set a new timeout to process the group after 1 second of no new messages
        groupData.timeout = setTimeout(async () => {
          await this.processGroupedMessagesMulti(
            groupedId,
            groupData.messages,
            channelConfig
          );
          this.groupedMessages.delete(groupedId);
        }, 1000);

        this.logger.log(
          `Collected message ${groupData.messages.length} for group ${groupedId}`
        );
        return;
      }

      // Not part of a group - process immediately
      await this.processSingleMessageMulti(message, channelConfig);
    } catch (error) {
      this.logger.error(
        `Error processing message: ${error.message}`,
        error.stack
      );
    }
  }

  private async handleNewMessage(event: NewMessageEvent) {
    try {
      const message = event.message;
      const messageText = message.message;
      const hasMedia = message.media;

      // Check if this message is part of a grouped media (album)
      const groupedId = (message as any).groupedId?.toString();

      if (groupedId) {
        // This is part of an album - collect all messages before processing
        if (!this.groupedMessages.has(groupedId)) {
          this.groupedMessages.set(groupedId, {
            messages: [],
            timeout: null as any,
            channelConfig: null as any,
          });
        }

        const groupData = this.groupedMessages.get(groupedId)!;
        groupData.messages.push(message);

        // Clear existing timeout
        if (groupData.timeout) {
          clearTimeout(groupData.timeout);
        }

        // Set a new timeout to process the group after 1 second of no new messages
        groupData.timeout = setTimeout(async () => {
          await this.processGroupedMessages(groupedId, groupData.messages);
          this.groupedMessages.delete(groupedId);
        }, 1000);

        this.logger.log(
          `Collected message ${groupData.messages.length} for group ${groupedId}`
        );
        return;
      }

      // Not part of a group - process immediately
      await this.processSingleMessage(message);
    } catch (error) {
      this.logger.error(
        `Error processing message: ${error.message}`,
        error.stack
      );
    }
  }

  private async processGroupedMessagesMulti(
    groupedId: string,
    messages: any[],
    channelConfig: ChannelConfig
  ) {
    try {
      this.logger.log(
        `Processing grouped messages (${messages.length} items) for group ${groupedId} from channel ${channelConfig.sourceId}`
      );

      // Get the text from the first message that has text
      const messageWithText = messages.find((msg) => msg.message);
      const messageText = messageWithText?.message || "";

      // Translate text if present
      let translatedText = "";
      if (messageText) {
        translatedText = await this.openaiService.translateToKorean(
          messageText,
          channelConfig.prompt
        );
        this.logger.log("Text translated to Korean");
      }

      // Collect all media from the messages
      const mediaFiles = messages
        .filter((msg) => msg.media)
        .map((msg) => msg.media);

      if (mediaFiles.length > 0) {
        // Send all media together as an album to the specific topic
        await this.telegramService.getClient().sendMessage(this.targetGroupId, {
          message: translatedText || "",
          file: mediaFiles,
          replyTo: channelConfig.targetTopicId,
        });

        this.logger.log(
          `✅ Album with ${mediaFiles.length} items posted to topic ${channelConfig.targetTopicId}`
        );
      } else {
        // No media, just send text
        await this.telegramService.getClient().sendMessage(this.targetGroupId, {
          message: translatedText,
          replyTo: channelConfig.targetTopicId,
        });
        this.logger.log(
          `Message translated and posted to topic ${channelConfig.targetTopicId}`
        );
      }
    } catch (error) {
      this.logger.error(
        `Error processing grouped messages: ${error.message}`,
        error.stack
      );
    }
  }

  private async processGroupedMessages(groupedId: string, messages: any[]) {
    try {
      this.logger.log(
        `Processing grouped messages (${messages.length} items) for group ${groupedId}`
      );

      // Get the text from the first message that has text
      const messageWithText = messages.find((msg) => msg.message);
      const messageText = messageWithText?.message || "";

      // Translate text if present
      let translatedText = "";
      if (messageText) {
        translatedText = await this.openaiService.translateToKorean(
          messageText
        );
        this.logger.log("Text translated to Korean");
      }

      // Collect all media from the messages
      const mediaFiles = messages
        .filter((msg) => msg.media)
        .map((msg) => msg.media);

      if (mediaFiles.length > 0) {
        // Send all media together as an album
        await this.telegramService
          .getClient()
          .sendMessage(this.targetChannelId, {
            message: translatedText || "",
            file: mediaFiles,
          });

        this.logger.log(
          `✅ Album with ${mediaFiles.length} items posted successfully`
        );
      } else {
        // No media, just send text
        await this.telegramService.sendMessage(
          this.targetChannelId,
          translatedText
        );
        this.logger.log("Message translated and posted successfully");
      }
    } catch (error) {
      this.logger.error(
        `Error processing grouped messages: ${error.message}`,
        error.stack
      );
    }
  }

  private async processSingleMessageMulti(
    message: any,
    channelConfig: ChannelConfig
  ) {
    try {
      const messageText = message.message;
      const hasMedia = message.media;
      const isPhoto = hasMedia && (message.media as any).photo !== undefined;
      const sourceMessageId = message.id;
      const replyToMsgId = message.replyTo?.replyToMsgId;

      // Log message info
      if (hasMedia) {
        this.logger.log(
          `New message with ${isPhoto ? "photo" : "media"} from channel ${
            channelConfig.sourceId
          }. Text: ${
            messageText ? messageText.substring(0, 50) : "(no text)"
          }...`
        );
      } else if (messageText) {
        this.logger.log(
          `New message from channel ${
            channelConfig.sourceId
          }: ${messageText.substring(0, 100)}...`
        );
      } else {
        this.logger.log("Received message without text or media, skipping...");
        return;
      }

      // Check if this is a reply to another message
      let targetReplyToMsgId: number | undefined;
      if (replyToMsgId) {
        targetReplyToMsgId = this.messageMapping.get(replyToMsgId);
        if (targetReplyToMsgId) {
          this.logger.log(
            `This is a reply to message ${replyToMsgId}, will reply to target message ${targetReplyToMsgId}`
          );
        } else {
          this.logger.warn(
            `This is a reply to message ${replyToMsgId}, but no mapping found in target channel`
          );
        }
      }

      // Translate text if present
      let translatedText = "";
      if (messageText) {
        translatedText = await this.openaiService.translateToKorean(
          messageText,
          channelConfig.prompt
        );
        this.logger.log("Text translated to Korean");
      }

      let sentMessage: any;

      // If message contains a photo, translate the image
      if (isPhoto) {
        try {
          this.logger.log(
            "📸 Downloading image for translation... Temporary disabled"
          );

          sentMessage = await this.telegramService
            .getClient()
            .sendMessage(this.targetGroupId, {
              message: translatedText,
              file: message.media,
              replyTo: targetReplyToMsgId || channelConfig.targetTopicId,
            });
        } catch (imageError) {
          this.logger.error(
            `Failed to send image: ${imageError.message}`,
            imageError.stack
          );
        }
      } else if (hasMedia) {
        // Other media types (video, audio, documents, etc.)
        sentMessage = await this.telegramService
          .getClient()
          .sendMessage(this.targetGroupId, {
            message: translatedText,
            file: message.media,
            replyTo: targetReplyToMsgId || channelConfig.targetTopicId,
          });
        this.logger.log(
          `Message with media posted to topic ${channelConfig.targetTopicId}`
        );
      } else {
        // Text-only message
        sentMessage = await this.telegramService
          .getClient()
          .sendMessage(this.targetGroupId, {
            message: translatedText,
            replyTo: targetReplyToMsgId || channelConfig.targetTopicId,
          });
        this.logger.log(
          `Message posted to topic ${channelConfig.targetTopicId}`
        );
      }

      // Store the message ID mapping
      if (sentMessage && sentMessage.id) {
        this.messageMapping.set(sourceMessageId, sentMessage.id);
        this.logger.log(
          `Stored mapping: source ${sourceMessageId} -> target ${sentMessage.id}`
        );
      }
    } catch (error) {
      this.logger.error(
        `Error processing single message: ${error.message}`,
        error.stack
      );
    }
  }

  private async processSingleMessage(message: any) {
    try {
      const messageText = message.message;
      const hasMedia = message.media;
      const isPhoto = hasMedia && (message.media as any).photo !== undefined;
      const sourceMessageId = message.id;
      const replyToMsgId = message.replyTo?.replyToMsgId;

      // Log message info
      if (hasMedia) {
        this.logger.log(
          `New message with ${isPhoto ? "photo" : "media"} received. Text: ${
            messageText ? messageText.substring(0, 50) : "(no text)"
          }...`
        );
      } else if (messageText) {
        this.logger.log(
          `New message received: ${messageText.substring(0, 100)}...`
        );
      } else {
        this.logger.log("Received message without text or media, skipping...");
        return;
      }

      // Check if this is a reply to another message
      let targetReplyToMsgId: number | undefined;
      if (replyToMsgId) {
        targetReplyToMsgId = this.messageMapping.get(replyToMsgId);
        if (targetReplyToMsgId) {
          this.logger.log(
            `This is a reply to message ${replyToMsgId}, will reply to target message ${targetReplyToMsgId}`
          );
        } else {
          this.logger.warn(
            `This is a reply to message ${replyToMsgId}, but no mapping found in target channel`
          );
        }
      }

      // Translate text if present
      let translatedText = "";
      if (messageText) {
        translatedText = await this.openaiService.translateToKorean(
          messageText
        );
        this.logger.log("Text translated to Korean");
      }

      let sentMessage: any;

      // If message contains a photo, translate the image
      if (isPhoto) {
        try {
          this.logger.log(
            "📸 Downloading image for translation... Temporary disabled"
          );

          sentMessage = await this.telegramService.sendMessageWithMedia(
            this.targetChannelId,
            translatedText,
            message,
            targetReplyToMsgId
          );
        } catch (imageError) {
          this.logger.error(
            `Failed to send image: ${imageError.message}`,
            imageError.stack
          );
          this.logger.warn("Falling back to sending original media");
          sentMessage = await this.telegramService.sendMessageWithMedia(
            this.targetChannelId,
            translatedText,
            message,
            targetReplyToMsgId
          );
        }
      } else if (hasMedia) {
        // Other media types (video, audio, documents, etc.)
        sentMessage = await this.telegramService.sendMessageWithMedia(
          this.targetChannelId,
          translatedText,
          message,
          targetReplyToMsgId
        );
        this.logger.log(
          "Message with media translated and posted successfully"
        );
      } else {
        // Text-only message
        sentMessage = await this.telegramService.sendMessage(
          this.targetChannelId,
          translatedText,
          targetReplyToMsgId
        );
        this.logger.log("Message translated and posted successfully");
      }

      // Store the message ID mapping
      if (sentMessage && sentMessage.id) {
        this.messageMapping.set(sourceMessageId, sentMessage.id);
        this.logger.log(
          `Stored mapping: source ${sourceMessageId} -> target ${sentMessage.id}`
        );
      }
    } catch (error) {
      this.logger.error(
        `Error processing single message: ${error.message}`,
        error.stack
      );
    }
  }

  private async handleEditedMessageMulti(
    event: any,
    channelConfig: ChannelConfig
  ) {
    try {
      const message = event.message;
      const sourceMessageId = message.id;
      const messageText = message.message;

      this.logger.log(
        `Message ${sourceMessageId} was edited in channel ${channelConfig.sourceId}`
      );

      // Check if we have a mapping for this message
      const targetMessageId = this.messageMapping.get(sourceMessageId);

      if (!targetMessageId) {
        this.logger.warn(
          `No mapping found for edited message ${sourceMessageId}, skipping edit`
        );
        return;
      }

      // Translate the new text
      let translatedText = "";
      if (messageText) {
        translatedText = await this.openaiService.translateToKorean(
          messageText,
          channelConfig.prompt
        );
        this.logger.log("Edited text translated to Korean");
      }

      // Edit the message in the target group
      await this.telegramService.editMessage(
        this.targetGroupId,
        targetMessageId,
        translatedText
      );

      this.logger.log(
        `✅ Message ${targetMessageId} edited successfully in topic ${channelConfig.targetTopicId}`
      );
    } catch (error) {
      this.logger.error(
        `Error handling edited message: ${error.message}`,
        error.stack
      );
    }
  }

  private async handleEditedMessage(event: any) {
    try {
      const message = event.message;
      const sourceMessageId = message.id;
      const messageText = message.message;

      this.logger.log(`Message ${sourceMessageId} was edited`);

      // Check if we have a mapping for this message
      const targetMessageId = this.messageMapping.get(sourceMessageId);

      if (!targetMessageId) {
        this.logger.warn(
          `No mapping found for edited message ${sourceMessageId}, skipping edit`
        );
        return;
      }

      // Translate the new text
      let translatedText = "";
      if (messageText) {
        translatedText = await this.openaiService.translateToKorean(
          messageText
        );
        this.logger.log("Edited text translated to Korean");
      }

      // Edit the message in the target channel
      await this.telegramService.editMessage(
        this.targetChannelId,
        targetMessageId,
        translatedText
      );

      this.logger.log(
        `✅ Message ${targetMessageId} edited successfully in target channel`
      );
    } catch (error) {
      this.logger.error(
        `Error handling edited message: ${error.message}`,
        error.stack
      );
    }
  }
}
