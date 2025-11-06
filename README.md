# Telegram Translator Bot

A NestJS-based Telegram bot that automatically translates messages from multiple Telegram channels to a group with topics using OpenAI.

## Features

- **Multi-Channel Support**: Monitor multiple source channels simultaneously
- **Topic-Based Routing**: Post messages to specific topics in a Telegram group
- **Custom Prompts**: Use different translation prompts for each channel
- **Flexible Configuration**: Prompts stored in JSON for easy customization
- **Full Message Support**: Handles text, media, photos, albums, and edits
- **Thread Preservation**: Maintains reply threads when translating
- **Legacy Mode**: Backward compatible with single-channel configuration

## Configuration

### Multi-Channel Mode (Recommended)

1. **Create `prompts.json`** with your custom translation prompts:

   ```json
   {
     "default": "Your default translation prompt...",
     "crypto": "Your crypto-specific prompt...",
     "news": "Your news translation prompt...",
     "casual": "Your casual conversation prompt..."
   }
   ```

2. **Configure `.env`** with multi-channel settings:

   ```env
   # Telegram API credentials
   TELEGRAM_API_ID=your_api_id
   TELEGRAM_API_HASH=your_api_hash
   TELEGRAM_PHONE=+1234567890

   # OpenAI API Key
   OPENAI_API_KEY=sk-your-openai-api-key

   # Session name
   SESSION_NAME=telegram_translator

   # Target group with topics
   TARGET_GROUP_ID=-1001234567890

   # Multi-channel configuration
   # Format: sourceChannelId:targetTopicId:promptKey,sourceChannelId:targetTopicId:promptKey,...
   CHANNELS_CONFIG=-1001111111111:123:default,-1002222222222:456:news,-1003333333333:789:crypto
   ```

   **How to get the IDs:**

   - **Channel ID**: Forward a message from the channel to [@userinfobot](https://t.me/userinfobot)
   - **Group ID**: Forward a message from the group to [@userinfobot](https://t.me/userinfobot)
   - **Topic ID**: Open the topic in Telegram Desktop, look at the URL. If the URL shows something like `-1002995160061_2`, use just the number after the underscore (in this case, `2`)

### Legacy Single-Channel Mode

For backward compatibility, you can still use the old configuration:

```env
SOURCE_CHANNEL_ID=-12345
TARGET_CHANNEL_ID=-67890
```

## Custom Prompts

The `prompts.json` file allows you to define multiple translation styles. Each channel can use a different prompt by referencing its key.

**Example prompts.json:**

```json
{
  "default": "Translate Russian to Korean. Keep the tone natural and polite.",
  "crypto": "Translate crypto trading content from Russian to Korean. Use casual trader language. Translate slang meaningfully.",
  "news": "Translate news articles from Russian to formal Korean. Use professional tone.",
  "casual": "Translate casual conversations to informal Korean. Keep emojis and slang."
}
```

**Benefits:**

- Large prompts don't clutter environment variables
- Easy to update without redeploying
- Channel IDs remain secure in `.env`
- Version control for prompt changes

## Deployment on Railway

### Prerequisites

- GitHub account
- Railway account (sign up at https://railway.app)
- Telegram API credentials
- OpenAI API key

### Deployment Steps

1. **Go to Railway:**

   - Visit https://railway.app
   - Click "New Project"
   - Select "Deploy from GitHub repo"
   - Choose the `telegram_translator` repository

2. **Configure `prompts.json`:**

   - The `prompts.json` file should be committed to your repository (it contains no sensitive data)
   - Customize the prompts for your needs
   - Commit and push to GitHub

3. **Configure Environment Variables:**
   Add the following environment variables in Railway:

   ```
   TELEGRAM_API_ID=your_telegram_api_id
   TELEGRAM_API_HASH=your_telegram_api_hash
   TELEGRAM_PHONE=your_phone_number
   SESSION_NAME=your_session_string
   TARGET_GROUP_ID=-1001234567890
   CHANNELS_CONFIG=-1001111111111:123:default,-1002222222222:456:news
   OPENAI_API_KEY=your_openai_api_key
   PORT=3000
   ```

4. **Deploy:**

   - Railway will automatically detect the Node.js project
   - It will run `npm install && npm run build`
   - Then start the app with `npm run start:prod`
   - Your bot will be running 24/7!

5. **Monitor:**
   - Check the logs in Railway dashboard
   - Visit the `/health` endpoint to verify the app is running

## Local Development

1. Clone the repository:

   ```bash
   git clone https://github.com/Demiduska/telegram_translator.git
   cd telegram_translator
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Customize `prompts.json` with your translation prompts (see Configuration section)

   - The repository includes `prompts.json` with default prompts
   - Modify them according to your needs

4. Create `.env` file based on `.env.example` and add your credentials

5. Run the application:
   ```bash
   npm run start
   ```

## API Endpoints

- `GET /` - Homepage (service status)
- `GET /health` - Health check endpoint

## Technologies Used

- NestJS
- Telegram MTProto Client
- OpenAI API
- TypeScript
- Express

## License

ISC
