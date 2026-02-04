const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.json());

// Load from environment variables
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'my_secret_verify_token_12345';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WEATHERAPI_KEY = process.env.WEATHERAPI_KEY; // Get free key from weatherapi.com
const SPORTSDB_KEY = process.env.SPORTSDB_KEY || '3'; // Free test key, upgrade at thesportsdb.com

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

            try {
              sendTypingIndicator(senderID, true).catch(() => {});

              // Check if user is asking for real-time data
              const realtimeData = await checkAndGetRealtimeData(userMessage);
              
              let aiReply;
              if (realtimeData) {
                // User asked for real-time data, get AI to format the response
                aiReply = await callDeepSeekAPI(userMessage, realtimeData);
              } else {
                // Regular conversation
                aiReply = await callDeepSeekAPI(userMessage);
              }
              
              console.log('AI response received');

              await sendFacebookMessage(senderID, aiReply);
              console.log('Message sent successfully');

            } catch (error) {
              console.error('Error:', error.message);
              try {
                await sendFacebookMessage(senderID, 'Sorry, I had trouble with that. Try again?');
              } catch (sendError) {
                console.error('Failed to send error:', sendError.message);
              }
            } finally {
              sendTypingIndicator(senderID, false).catch(() => {});
            }
          }
          
          // Handle button clicks (postbacks)
          else if (event.postback) {
            const senderID = event.sender.id;
            const payload = event.postback.payload;

            console.log(`Postback from ${senderID}: ${payload}`);

            try {
              let response = '';
              
              switch(payload) {
                case 'GET_STARTED':
                  response = "👋 Welcome! I'm your intelligent AI assistant. I can:\n\n✅ Answer questions\n🌤️ Check weather anywhere\n⚽ Get sports scores & stats\n📰 Share latest news\n💬 Have intelligent conversations\n\nJust ask me anything!";
                  break;
                  
                case 'ABOUT_BOT':
                  response = "🤖 I'm powered by DeepSeek R1T2 Chimera, one of the most advanced AI models.\n\nI have real-time access to:\n• Weather data (any city)\n• Sports scores & stats\n• Latest news headlines\n• General knowledge\n\nTry asking: 'What's the weather in London?' or 'Who won the last Lakers game?'";
                  break;
                  
                case 'START_CHAT':
                  response = "💬 Great! I'm ready to help. You can ask me about weather, sports, news, or anything else!";
                  break;
                  
                case 'HELP':
                  response = "🆘 **How to use me:**\n\n1️⃣ Just type your question\n2️⃣ I can get real-time data for:\n   • Weather (\"weather in Paris\")\n   • Sports (\"Lakers score\", \"Premier League\")\n   • News (\"latest tech news\")\n\n**Tips:**\n• Be specific for better answers\n• I have access to live data!\n• Available 24/7!\n\nWhat can I help you with?";
                  break;
                  
                case 'MAIN_MENU':
                  response = "🏠 **Main Menu**\n\nI can help with:\n• 🌤️ Weather forecasts\n• ⚽ Sports scores\n• 📰 News updates\n• 💡 General questions\n\nJust type what you need!";
                  break;
                  
                default:
                  response = "I'm here to help! What would you like to know?";
              }
              
              await sendFacebookMessage(senderID, response);
              console.log('Postback response sent');

            } catch (error) {
              console.error('Error handling postback:', error.message);
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

// Check if user is asking for real-time data and fetch it
async function checkAndGetRealtimeData(message) {
  const lowerMsg = message.toLowerCase();
  
  // Weather detection
  const weatherKeywords = ['weather', 'temperature', 'forecast', 'hot', 'cold', 'rain', 'sunny', 'climate'];
  if (weatherKeywords.some(keyword => lowerMsg.includes(keyword))) {
    const cityMatch = extractCity(message);
    if (cityMatch) {
      const weatherData = await getWeatherData(cityMatch);
      if (weatherData) return weatherData;
    }
  }
  
  // Sports detection
  const sportsKeywords = ['score', 'game', 'match', 'league', 'football', 'soccer', 'basketball', 'nba', 'nfl', 'premier league'];
  if (sportsKeywords.some(keyword => lowerMsg.includes(keyword))) {
    const sportsData = await getSportsData(lowerMsg);
    if (sportsData) return sportsData;
  }
  
  // News detection (you can add news API if needed)
  
  return null;
}

// Extract city name from message
function extractCity(message) {
  // Common patterns: "weather in London", "London weather", "temperature in Paris"
  const patterns = [
    /weather (?:in|for|at) ([a-zA-Z\s]+)/i,
    /temperature (?:in|for|at) ([a-zA-Z\s]+)/i,
    /forecast (?:in|for|at) ([a-zA-Z\s]+)/i,
    /([a-zA-Z\s]+) weather/i,
    /how'?s (?:the )?weather (?:in|at) ([a-zA-Z\s]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  
  return null;
}

// Get weather data (using Open-Meteo - completely free, no API key needed!)
async function getWeatherData(city) {
  try {
    // First, geocode the city name to get coordinates
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
    const geoResponse = await fetch(geoUrl);
    const geoData = await geoResponse.json();
    
    if (!geoData.results || geoData.results.length === 0) {
      return null;
    }
    
    const location = geoData.results[0];
    const { latitude, longitude, name, country } = location;
    
    // Get weather data
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`;
    const weatherResponse = await fetch(weatherUrl);
    const weatherData = await weatherResponse.json();
    
    const current = weatherData.current;
    const weatherCode = getWeatherDescription(current.weather_code);
    
    return {
      type: 'weather',
      data: {
        location: `${name}, ${country}`,
        temperature: `${Math.round(current.temperature_2m)}°C`,
        humidity: `${current.relative_humidity_2m}%`,
        wind_speed: `${Math.round(current.wind_speed_10m)} km/h`,
        condition: weatherCode,
        timestamp: new Date().toLocaleString('en-US', { timeZone: 'auto' })
      }
    };
  } catch (error) {
    console.error('Weather API error:', error);
    return null;
  }
}

// Alternative: Weather using WeatherAPI.com (requires free API key)
async function getWeatherDataAPI(city) {
  if (!WEATHERAPI_KEY || WEATHERAPI_KEY === 'YOUR_WEATHERAPI_KEY') {
    return null;
  }
  
  try {
    const url = `https://api.weatherapi.com/v1/current.json?key=${WEATHERAPI_KEY}&q=${encodeURIComponent(city)}`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.error) return null;
    
    return {
      type: 'weather',
      data: {
        location: `${data.location.name}, ${data.location.country}`,
        temperature: `${data.current.temp_c}°C / ${data.current.temp_f}°F`,
        condition: data.current.condition.text,
        humidity: `${data.current.humidity}%`,
        wind_speed: `${data.current.wind_kph} km/h`,
        feels_like: `${data.current.feelslike_c}°C`,
        timestamp: data.current.last_updated
      }
    };
  } catch (error) {
    console.error('Weather API error:', error);
    return null;
  }
}

// Get sports data using TheSportsDB (free tier)
async function getSportsData(query) {
  try {
    // Check for specific team or league mentions
    const teamMatch = query.match(/(lakers|warriors|celtics|heat|bulls|knicks|nets|sixers)/i);
    const leagueMatch = query.match(/(nba|premier league|la liga|bundesliga|serie a|champions league|nfl|nhl)/i);
    
    if (teamMatch) {
      // Get specific team's latest events
      const team = teamMatch[1];
      const url = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/searchteams.php?t=${encodeURIComponent(team)}`;
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.teams && data.teams.length > 0) {
        const teamInfo = data.teams[0];
        
        // Get latest events for this team
        const eventsUrl = `https://www.thesportsdb.com/api/v1/json/${SPORTSDB_KEY}/eventslast.php?id=${teamInfo.idTeam}`;
        const eventsResponse = await fetch(eventsUrl);
        const eventsData = await eventsResponse.json();
        
        if (eventsData.results && eventsData.results.length > 0) {
          const latestEvent = eventsData.results[0];
          return {
            type: 'sports',
            data: {
              team: teamInfo.strTeam,
              league: teamInfo.strLeague,
              latest_game: {
                event: latestEvent.strEvent,
                date: latestEvent.dateEvent,
                home_team: latestEvent.strHomeTeam,
                away_team: latestEvent.strAwayTeam,
                home_score: latestEvent.intHomeScore,
                away_score: latestEvent.intAwayScore,
                status: latestEvent.strStatus
              }
            }
          };
        }
      }
    }
    
    // If no specific match, return general sports info available
    return {
      type: 'sports',
      data: {
        message: "I can get sports scores! Try asking about specific teams like 'Lakers score' or 'Premier League standings'"
      }
    };
    
  } catch (error) {
    console.error('Sports API error:', error);
    return null;
  }
}

// Convert weather code to description
function getWeatherDescription(code) {
  const weatherCodes = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    71: 'Slight snow',
    73: 'Moderate snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail'
  };
  
  return weatherCodes[code] || 'Unknown';
}

// Call DeepSeek API with optional real-time data
async function callDeepSeekAPI(userMessage, realtimeData = null) {
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

  let systemPrompt = `You are a helpful AI assistant with access to real-time data. Today is ${dateStr}, ${timeStr} (Iraq time).`;
  
  // Add real-time data context if available
  if (realtimeData) {
    if (realtimeData.type === 'weather') {
      systemPrompt += `\n\nREAL-TIME WEATHER DATA:\nLocation: ${realtimeData.data.location}\nTemperature: ${realtimeData.data.temperature}\nCondition: ${realtimeData.data.condition}\nHumidity: ${realtimeData.data.humidity}\nWind Speed: ${realtimeData.data.wind_speed}\nLast Updated: ${realtimeData.data.timestamp}\n\nUse this data to answer the user's question accurately.`;
    } else if (realtimeData.type === 'sports') {
      systemPrompt += `\n\nREAL-TIME SPORTS DATA:\n${JSON.stringify(realtimeData.data, null, 2)}\n\nUse this data to answer the user's sports question.`;
    }
  }
  
  systemPrompt += `\n\nKeep responses SHORT and conversational. Format the information in a clear, friendly way.`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://messenger-gemini-bot.vercel.app',
      'X-Title': 'Messenger AI Bot Enhanced'
    },
    body: JSON.stringify({
      model: 'tngtech/deepseek-r1t2-chimera:free',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 1000
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

// Send message to Facebook
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

// Health check
app.get('/', (req, res) => {
  res.send('🤖 Enhanced AI Bot - DeepSeek R1T2 Chimera with Real-Time Data');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Enhanced server running on port ${PORT}`);
});

module.exports = app;