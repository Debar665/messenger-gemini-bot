const express = require('express');
const bodyParser = require('body-parser');
const { generateText } = require('ai');
const { google } = require('@ai-sdk/google');

const app = express();
app.use(bodyParser.json());

// Your tokens - NOT CHANGED
const PAGE_ACCESS_TOKEN = 'EAAUBZCxMBc3gBQqaaEwsnLAvhIwEUTgN3EHYnm0GCmHVaxAqGb7E4yJSKOfrhOMO8ZCV9T2qHZAEeQzZAYXQZBusEg9bQYiJpixsGFToWusTj4qCdWPS7M0i6q6P8JmramD4Oc3rF2oNZCx8wwBSZBDzyioNx0LTDgOZC0kFi6xZAbBZAoc0Smgwm49KoZCIW5TZCAaARxpMZAOKlEwLr5jKZCMZCve';
const VERIFY_TOKEN = 'my_secret_verify_token_12345';
const GEMINI_API_KEY = 'AIzaSyDRiMBJzpe0LiwNEb8UmINkq4ILw2fHpBU';

// Set environment variable for AI SDK
process.env.GOOGLE_GENERATIVE_AI_API_KEY = GEMINI_API_KEY;

// Initialize Gemini model
const model = google('gemini-2.5-flash');

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    body.entry.forEach(async (entry) => {
      const webhookEvent = entry.messaging[0];
      const senderID = webhookEvent.sender.id;
      const message = webhookEvent.message;

      if (message && message.text) {
        const userMessage = message.text;
        
        try {
          // Ask Gemini using Vercel AI SDK
          const { text } = await generateText({
            model: model,
            prompt: userMessage,
          });
          
          // Send reply back to user
          await sendMessage(senderID, text);
        } catch (error) {
          console.error('Error:', error);
          await sendMessage(senderID, 'Sorry, I encountered an error. Please try again.');
        }
      }
    });
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// Function to send message
async function sendMessage(recipientID, messageText) {
  const response = await fetch(
    `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientID },
        message: { text: messageText }
      })
    }
  );
  return response.json();
}

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Bot is running!');
});

// For Vercel serverless
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Export for Vercel
module.exports = app;