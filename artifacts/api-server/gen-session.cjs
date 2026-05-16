const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions/index.js');

const API_ID = 21753804;
const API_HASH = "730061adaccddbe34ff27140f870e127";
const BOT_TOKEN = "8412788142:AAGs1-fYG62IabptxzOpwRaBHX9sAzB_Nko";

(async () => {
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {});
  await client.start({ botAuthToken: BOT_TOKEN });
  console.log('SESSION_OUTPUT_START');
  console.log(client.session.save());
  console.log('SESSION_OUTPUT_END');
  await client.disconnect();
  process.exit(0);
})();
