const { SessionsClient } = require('@google-cloud/dialogflow');

const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

const sessionClient = new SessionsClient({
  credentials: {
    client_email: credentials.client_email,
    private_key: credentials.private_key,
  },
});

module.exports = sessionClient;