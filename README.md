# Consensus Flow

App web minimalista para deliberación ciudadana asistida por voz.

## Qué hace

- Graba la conversación.
- Transcribe en vivo cuando el navegador soporta Web Speech API.
- Detecta cambios probables de hablante por firma de voz (tono + energía).
- Detecta automáticamente el tema principal de la discusión.
- Interpreta argumentos y propone un consenso deliberado.
- Guarda deliberaciones en localStorage.

## Uso

1. Abre `/Users/xabi/Documents/New project/index.html`.
2. Pulsa `Iniciar` para grabar/transcribir.
3. Pulsa `Detener` al terminar.
4. Pulsa `Deliberar` para generar tema, balance argumental y propuesta de consenso.

## Nota

La detección de hablante/tono y el análisis de consenso son heurísticos locales (MVP).
