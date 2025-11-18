// server.js (Código Unificado)
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const dialogflow = require('@google-cloud/dialogflow');
const uuid = require('uuid'); // Se mantiene, aunque usaremos fromNumber como sessionId para memoria
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');

// --- 1. Inicialización de Clientes ---
const app = express();
const port = process.env.PORT || 3000;

// Middleware (Tu configuración original)
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Clientes para las APIs
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const projectId = process.env.DIALOGFLOW_PROJECT_ID;
const sessionClient = new dialogflow.SessionsClient({
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
});

// --- 2. WEBHOOK de WhatsApp (Twilio Original) ---
app.post('/webhook', async (req, res) => {
    const userMessage = req.body.Body;
    const fromNumber = req.body.From; // Usado como senderId

    try {
        // LLAMADA CLAVE: La orquestación completa de RAG/Dialogflow
        const finalReply = await handleConversation(userMessage, fromNumber);
        
        // --- RESPUESTA TWILIO (Tu formato original, sin cambios) ---
        const twimlReply = (finalReply === 'HANDOFF_TO_HUMAN')
            ? "Lo siento, la consulta requiere asistencia humana. Un agente se pondrá en contacto pronto."
            : finalReply;

        const twiml = `
            <Response>
                <Message>${twimlReply}</Message>
            </Response>
        `;

        res.set('Content-Type', 'text/xml');
        res.send(twiml);
        // -----------------------------------------------------------

    } catch (err) {
        console.error('ERROR EN EL PROCESO RAG:', err);
        res.status(500).send('<Response><Message>Error interno del sistema.</Message></Response>');
    }
});

app.listen(port, () => {
    console.log(`Webhook de WhatsApp + Dialogflow + RAG escuchando en el puerto ${port}`);
});


// --- 3. Funciones del Cerebro (Lógica RAG) ---

/**
 * ORQUESTADOR: Maneja el flujo de Dialogflow -> RAG (Supabase + OpenAI)
 */
async function handleConversation(query, senderId) {
    
    // 1. FILTRO DIALOGFLOW
    const dialogflowResponse = await checkDialogflow(query, senderId);
    
    if (dialogflowResponse.intent !== 'Default Fallback Intent') {
        return dialogflowResponse.text; // Respuesta rápida de Dialogflow
    }

    // 2. FALLBACK RAG 
    const context = await getRagContext(query);
    
    if (context) {
        // La función generateAiResponse devuelve el token HANDOFF_TO_HUMAN si no hay respuesta.
        return await generateAiResponse(query, context);
    }

    // 3. RESPUESTA FINAL SI NADA FUNCIONA (Transferencia a humano)
    return "HANDOFF_TO_HUMAN";
}


/**
 * FILTRO DE BAJA LATENCIA (Dialogflow)
 */
async function checkDialogflow(query, senderId) {
    // Usamos el senderId (número de WhatsApp) como Session ID para mantener la conversación
    const sessionPath = sessionClient.projectAgentSessionPath(projectId, senderId.replace('whatsapp:', ''));
    
    const request = { 
        session: sessionPath, 
        queryInput: { 
            text: { text: query, languageCode: 'es-ES' } 
        } 
    };

    try {
        const responses = await sessionClient.detectIntent(request);
        const result = responses[0].queryResult;
        const intentName = result.intent ? result.intent.displayName : 'Default Fallback Intent';
        
        return { 
            intent: intentName, 
            text: result.fulfillmentText, 
            isFallback: (intentName === 'Default Fallback Intent') 
        };
    } catch (e) {
        console.error('ERROR DIALOGFLOW:', e);
        return { intent: 'API_ERROR', text: "Error de clasificación.", isFallback: true };
    }
}


/**
 * BÚSQUEDA DE CONTEXTO (Supabase RPC)
 */
async function getRagContext(query) {
    
    // 1. GENERAR EMBEDDING (Vector)
    const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small", 
        input: query,
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // 2. LLAMAR A LA FUNCIÓN PL/PGSQL (RPC)
    try {
        const { data: knowledgeChunks } = await supabase.rpc('match_knowledge', {
            query_embedding: queryEmbedding,
            match_threshold: 0.75, // Ajustado para ser estricto
            match_count: 3,        
        });

        if (!knowledgeChunks || knowledgeChunks.length === 0) return null;

        // Formateamos los resultados para el prompt
        const context = knowledgeChunks.map(chunk => 
            `Título: ${chunk.source_title}\nContenido: ${chunk.content}`
        ).join('\n---\n');

        return context;

    } catch (e) {
        console.error("Error en RAG/Supabase:", e);
        return null;
    }
}


/**
 * GENERACIÓN DE RESPUESTA (OpenAI con Prompt Estricto)
 */
async function generateAiResponse(query, context) {
    const systemPrompt = `Eres un experto de soporte. Responde la pregunta del cliente usando ÚNICAMENTE el CONTEXTO proporcionado. REGLA ESTRICTA: Si no puedes responder con el contexto, responde ÚNICAMENTE con la frase: "HANDOFF_TO_HUMAN". CONTEXTO DISPONIBLE: ---\n${context}\n---`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Rápido y económico
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: query },
            ],
            temperature: 0.1, // Baja temperatura para consistencia
            max_tokens: 300,
        });

        return response.choices[0].message.content.trim();

    } catch (e) {
        console.error("Error llamando a OpenAI:", e);
        return "Hubo un error al consultar la IA.";
    }
}