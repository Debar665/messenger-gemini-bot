const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// Load from environment variables
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_secret_verify_token_12345';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages and postbacks
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook received');

    if (body.object === 'page') {
      for (const entry of body.entry) {
        const pageID = entry.id;
        
        for (const event of entry.messaging) {
          // Handle regular messages
          if (event.message && 
              event.message.text && 
              !event.message.is_echo &&
              event.sender &&
              event.sender.id !== pageID) {
            
            const senderID = event.sender.id;
            const userMessage = event.message.text;

            console.log(`Message from ${senderID}: ${userMessage}`);

            // ✅ FEATURE 3: Smart Input Validation
            if (!isValidMessage(userMessage)) {
              console.log('Invalid message detected (spam/emoji-only)');
              await sendMessageWithQuickReplies(
                senderID,
                "I didn't quite catch that! 🤔 Try asking me something like:",
                [
                  { title: "What can you do?", payload: "ABOUT_BOT" },
                  { title: "Ask a question", payload: "START_CHAT" },
                  { title: "Get help", payload: "HELP" }
                ]
              );
              continue;
            }

            try {
              // Mark message as seen
              await markSeen(senderID);
              
              // Show typing indicator
              sendTypingIndicator(senderID, true).catch(() => {});

              // Get AI response
              const aiReply = await callDeepSeekAPI(userMessage);
              console.log('AI response received');

              // Turn off typing
              await sendTypingIndicator(senderID, false);

              // ✅ FEATURE 2: Message Splitting (for long responses)
              const messageChunks = splitMessage(aiReply, 2000);
              
              // Send each chunk
              for (let i = 0; i < messageChunks.length; i++) {
                if (i > 0) {
                  // Small delay between chunks
                  await sleep(800);
                }
                
                // Last chunk gets quick reply buttons
                if (i === messageChunks.length - 1) {
                  // ✅ FEATURE 1: Quick Reply Buttons
                  await sendMessageWithQuickReplies(
                    senderID,
                    messageChunks[i],
                    [
                      { title: "Ask another question", payload: "CONTINUE" },
                      { title: "Main Menu", payload: "MAIN_MENU" },
                      { title: "Help", payload: "HELP" }
                    ]
                  );
                } else {
                  // Other chunks sent normally
                  await sendFacebookMessage(senderID, messageChunks[i]);
                }
              }

              console.log('All messages sent successfully');

            } catch (error) {
              console.error('Error:', error.message);
              await sendTypingIndicator(senderID, false);
              
              try {
                await sendMessageWithQuickReplies(
                  senderID,
                  "Oops! Something went wrong. 😔 Let's try again!",
                  [
                    { title: "Retry", payload: "START_CHAT" },
                    { title: "Main Menu", payload: "MAIN_MENU" },
                    { title: "Get Help", payload: "HELP" }
                  ]
                );
              } catch (sendError) {
                console.error('Failed to send error:', sendError.message);
              }
            }
          }
          
          // Handle button clicks (postbacks) and quick replies
          else if (event.postback || (event.message && event.message.quick_reply)) {
            const senderID = event.sender.id;
            const payload = event.postback ? event.postback.payload : event.message.quick_reply.payload;

            console.log(`Button clicked from ${senderID}: ${payload}`);

            try {
              await markSeen(senderID);
              let response = '';
              let quickReplies = [];
              
              switch(payload) {
                case 'GET_STARTED':
                  response = "👋 Welcome! I'm your AI assistant powered by advanced AI.\n\nI can help you with:\n✅ Answering questions\n✅ Explaining concepts\n✅ Having conversations\n✅ Problem-solving\n\nWhat would you like to know?";
                  quickReplies = [
                    { title: "What can you do?", payload: "ABOUT_BOT" },
                    { title: "Start chatting", payload: "START_CHAT" },
                    { title: "Get help", payload: "HELP" }
                  ];
                  break;
                  
                case 'ABOUT_BOT':
                  response = "🤖 I'm powered by DeepSeek R1T2 Chimera - one of the most advanced AI models!\n\nI excel at:\n• General knowledge & facts\n• Detailed explanations\n• Creative writing\n• Problem-solving\n• Coding help\n• And much more!\n\nI'm here 24/7 to help you!";
                  quickReplies = [
                    { title: "Ask me something", payload: "START_CHAT" },
                    { title: "See examples", payload: "EXAMPLES" },
                    { title: "Main Menu", payload: "MAIN_MENU" }
                  ];
                  break;
                  
                case 'START_CHAT':
                case 'CONTINUE':
                  response = "Perfect! 😊 I'm ready to help. What's on your mind?";
                  quickReplies = [
                    { title: "Example questions", payload: "EXAMPLES" },
                    { title: "What can you do?", payload: "ABOUT_BOT" },
                    { title: "Help", payload: "HELP" }
                  ];
                  break;
                  
                case 'EXAMPLES':
                  response = "💡 **Try asking me:**\n\n• \"Explain how photosynthesis works\"\n• \"Write a short story about space\"\n• \"Help me solve this math problem\"\n• \"What's the difference between X and Y?\"\n• \"Give me tips for learning programming\"\n\nJust type your question!";
                  quickReplies = [
                    { title: "Ask a question", payload: "START_CHAT" },
                    { title: "What can you do?", payload: "ABOUT_BOT" },
                    { title: "Main Menu", payload: "MAIN_MENU" }
                  ];
                  break;
                  
                case 'HELP':
                  response = "🆘 **How to use me:**\n\n1️⃣ Type your question naturally\n2️⃣ I'll respond with helpful info\n3️⃣ Ask follow-ups for more details\n4️⃣ Use quick reply buttons for shortcuts!\n\n**Note:** I can't access real-time info like live sports scores or current news.\n\nWhat can I help you with?";
                  quickReplies = [
                    { title: "Start chatting", payload: "START_CHAT" },
                    { title: "See examples", payload: "EXAMPLES" },
                    { title: "Main Menu", payload: "MAIN_MENU" }
                  ];
                  break;
                  
                case 'MAIN_MENU':
                  response = "🏠 **Main Menu**\n\nWhat would you like to do?";
                  quickReplies = [
                    { title: "Ask a question", payload: "START_CHAT" },
                    { title: "What can you do?", payload: "ABOUT_BOT" },
                    { title: "See examples", payload: "EXAMPLES" },
                    { title: "Get help", payload: "HELP" }
                  ];
                  break;
                  
                default:
                  response = "I'm here to help! What would you like to know?";
                  quickReplies = [
                    { title: "Ask a question", payload: "START_CHAT" },
                    { title: "Main Menu", payload: "MAIN_MENU" }
                  ];
              }
              
              await sendMessageWithQuickReplies(senderID, response, quickReplies);
              console.log('Response sent with quick replies');

            } catch (error) {
              console.error('Error handling button:', error.message);
            }
          }
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');

  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('ERROR');
  }
});

// ✅ FEATURE 3: Smart Input Validation
function isValidMessage(text) {
  // Remove whitespace
  const trimmed = text.trim();
  
  // Check minimum length
  if (trimmed.length < 2) return false;
  
  // Check if it's only emojis/symbols
  const onlyEmojisOrSymbols = /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]*$/u;
  if (onlyEmojisOrSymbols.test(trimmed)) return false;
  
  // Check if it's repetitive spam (same char repeated)
  const sameCharPattern = /^(.)\1{4,}$/;
  if (sameCharPattern.test(trimmed)) return false;
  
  // Check if it has at least some letters
  const hasLetters = /[a-zA-Z\u0600-\u06FF]/.test(trimmed); // Includes Arabic
  if (!hasLetters) return false;
  
  return true;
}

// ✅ FEATURE 2: Message Splitting
function splitMessage(text, maxLength = 2000) {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  const paragraphs = text.split('\n\n');
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    if ((currentChunk + '\n\n' + paragraph).length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // If single paragraph is too long, split by sentences
      if (paragraph.length > maxLength) {
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
        
        for (const sentence of sentences) {
          if ((currentChunk + sentence).length > maxLength) {
            if (currentChunk) {
              chunks.push(currentChunk.trim());
            }
            currentChunk = sentence;
          } else {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
          }
        }
      } else {
        currentChunk = paragraph;
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

// Mark message as seen
async function markSeen(recipientID) {
  try {
    await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientID },
        sender_action: 'mark_seen'
      })
    });
  } catch (error) {
    // Ignore
  }
}

// Typing indicator
async function sendTypingIndicator(recipientID, isTyping) {
  try {
    await fetch(`https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientID },
        sender_action: isTyping ? 'typing_on' : 'typing_off'
      })
    });
  } catch (error) {
    // Ignore
  }
}

// Call DeepSeek API
async function callDeepSeekAPI(userMessage) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Baghdad'
  });

  const systemPrompt = `You are a helpful AI assistant. Today is ${dateStr}, ${timeStr} (Iraq time).

Keep responses helpful and conversational. If asked about real-time info (sports scores, live news), politely say you can't access live data and suggest checking official sources.`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://messenger-gemini-bot.vercel.app',
      'X-Title': 'Messenger AI Bot'
    },
    body: JSON.stringify({
      model: 'tngtech/deepseek-r1t2-chimera:free',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 1500
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI error: ${response.status}`);
  }

  const data = await response.json();
  
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  
  throw new Error('No AI response');
}

// ✅ FEATURE 1: Send message WITH Quick Reply Buttons
async function sendMessageWithQuickReplies(recipientID, messageText, quickReplies = []) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const messageData = {
    recipient: { id: recipientID },
    message: { text: messageText }
  };

  // Add quick replies if provided
  if (quickReplies.length > 0) {
    messageData.message.quick_replies = quickReplies.map(qr => ({
      content_type: 'text',
      title: qr.title,
      payload: qr.payload
    }));
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(messageData)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Facebook error: ${response.status}`);
  }

  return await response.json();
}

// Send regular message (without quick replies)
async function sendFacebookMessage(recipientID, messageText) {
  const url = `https://graph.facebook.com/v18.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientID },
      message: { text: messageText }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Facebook error: ${response.status}`);
  }

  return await response.json();
}

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Health check
app.get('/', (req, res) => {
  res.send('🤖 Professional AI Bot v2.0 - Production Ready!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;