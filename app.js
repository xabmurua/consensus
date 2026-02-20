const STORAGE_KEY = "consensus-flow-v3";

const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const analyzeBtn = document.getElementById("analyze-btn");
const clearBtn = document.getElementById("clear-btn");
const transcriptBox = document.getElementById("transcript");
const consensusBox = document.getElementById("consensus");
const statusNode = document.getElementById("status");
const audioNode = document.getElementById("audio");
const downloadNode = document.getElementById("download");
const listNode = document.getElementById("list");
const itemTemplate = document.getElementById("item-template");

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const TOPIC_LEXICON = {
  movilidad: ["trafico", "movilidad", "bus", "peaton", "carril", "bicicleta", "transporte"],
  seguridad: ["seguridad", "delito", "camara", "iluminacion", "accidente", "vial"],
  vivienda: ["vivienda", "alquiler", "barrio", "hogar", "edificio", "inmueble"],
  presupuesto: ["presupuesto", "coste", "costo", "impuesto", "recursos", "financiar"],
  ambiente: ["arbol", "contaminacion", "verde", "clima", "residuos", "sostenible"],
  convivencia: ["ruido", "convivencia", "comunidad", "vecinos", "inclusion", "espacio publico"]
};

const POSITIVE_MARKERS = ["apoyo", "acuerdo", "beneficio", "viable", "mejora", "importante", "util"];
const NEGATIVE_MARKERS = ["rechazo", "problema", "riesgo", "costoso", "dificil", "injusto", "no funciona"];

const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "y", "o", "en", "que", "a", "un", "una", "para", "con", "por", "del",
  "se", "es", "al", "lo", "como", "mas", "pero", "si", "no", "ya", "muy", "hay", "ser", "sobre", "entre"
]);

let deliberations = loadState();
let utterances = [];

let mediaRecorder;
let audioChunks = [];
let stream;
let recognition;
let active = false;
let pendingInterimText = "";

let audioCtx;
let analyser;
let toneInterval;
let toneBuffer = [];
let speakerProfiles = [];
let speakerCounter = 1;
let lastSpeakerId;

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deliberations));
}

function normalize(text) {
  return text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function estimatePitch(timeData, sampleRate) {
  let crossings = 0;
  for (let i = 1; i < timeData.length; i += 1) {
    if (timeData[i - 1] < 128 && timeData[i] >= 128) crossings += 1;
  }
  const freq = (crossings * sampleRate) / (2 * timeData.length);
  if (!Number.isFinite(freq) || freq < 70 || freq > 400) return 0;
  return freq;
}

function rms(timeData) {
  let sumSq = 0;
  for (let i = 0; i < timeData.length; i += 1) {
    const v = (timeData[i] - 128) / 128;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / timeData.length);
}

function toneLabel(signature) {
  if (!signature) return "tono estable";
  if (signature.energy > 0.2 || signature.pitch > 230) return "tono intenso";
  if (signature.energy < 0.08) return "tono calmado";
  return "tono moderado";
}

function distance(a, b) {
  const dp = Math.abs(a.pitch - b.pitch) / 220;
  const de = Math.abs(a.energy - b.energy) / 0.4;
  return Math.sqrt(dp * dp + de * de);
}

function assignSpeaker(signature) {
  if (!signature || signature.pitch === 0) {
    return { id: lastSpeakerId || "H1", changed: false, tone: toneLabel(signature) };
  }

  let best;
  let bestDist = Infinity;

  speakerProfiles.forEach((profile) => {
    const d = distance(signature, profile);
    if (d < bestDist) {
      bestDist = d;
      best = profile;
    }
  });

  let chosen;
  if (!best || bestDist > 0.22) {
    chosen = { id: `H${speakerCounter++}`, pitch: signature.pitch, energy: signature.energy };
    speakerProfiles.push(chosen);
  } else {
    best.pitch = (best.pitch * 0.7) + (signature.pitch * 0.3);
    best.energy = (best.energy * 0.7) + (signature.energy * 0.3);
    chosen = best;
  }

  const changed = Boolean(lastSpeakerId && chosen.id !== lastSpeakerId);
  lastSpeakerId = chosen.id;
  return { id: chosen.id, changed, tone: toneLabel(signature) };
}

function currentSignature() {
  if (!toneBuffer.length) return null;
  const pitchValues = toneBuffer.map((x) => x.pitch).filter((x) => x > 0);
  const energyValues = toneBuffer.map((x) => x.energy);
  const avgPitch = pitchValues.length ? pitchValues.reduce((a, b) => a + b, 0) / pitchValues.length : 0;
  const avgEnergy = energyValues.reduce((a, b) => a + b, 0) / Math.max(1, energyValues.length);
  return { pitch: avgPitch, energy: avgEnergy };
}

function appendUtterance(text) {
  const clean = text.trim();
  if (!clean) return;

  const signature = currentSignature();
  const speaker = assignSpeaker(signature);
  const t = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

  utterances.push({
    text: clean,
    speaker: speaker.id,
    tone: speaker.tone,
    changed: speaker.changed,
    time: t
  });
  renderTranscript();
}

function flushPendingInterim() {
  if (!pendingInterimText.trim()) return;
  appendUtterance(pendingInterimText);
  pendingInterimText = "";
}

function renderTranscript() {
  transcriptBox.innerHTML = "";
  if (!utterances.length) {
    transcriptBox.textContent = "Sin transcripción.";
    return;
  }

  utterances.forEach((u) => {
    const node = document.createElement("div");
    node.className = "utterance";
    const switchTag = u.changed ? " • cambio de hablante" : "";
    node.innerHTML = `<strong>${u.speaker} · ${u.tone}${switchTag} · ${u.time}</strong><br>${u.text}`;
    transcriptBox.appendChild(node);
  });
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function detectTopic(lines) {
  const scores = {};
  Object.keys(TOPIC_LEXICON).forEach((k) => {
    scores[k] = 0;
  });

  lines.forEach((u) => {
    const text = normalize(u.text);
    Object.entries(TOPIC_LEXICON).forEach(([topic, words]) => {
      words.forEach((w) => {
        if (text.includes(w)) scores[topic] += 1;
      });
    });
  });

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] > 0) return ranked[0][0];

  const freq = {};
  lines.forEach((u) => {
    normalize(u.text)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOPWORDS.has(w) && w.length > 3)
      .forEach((w) => {
        freq[w] = (freq[w] || 0) + 1;
      });
  });
  const bestWord = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
  return bestWord ? `tema: ${bestWord[0]}` : "tema general ciudadano";
}

function classify(text) {
  const t = normalize(text);
  const pro = POSITIVE_MARKERS.reduce((acc, w) => (t.includes(normalize(w)) ? acc + 1 : acc), 0);
  const con = NEGATIVE_MARKERS.reduce((acc, w) => (t.includes(normalize(w)) ? acc + 1 : acc), 0);
  if (pro > con) return "pro";
  if (con > pro) return "con";
  return "neutral";
}

function deliberate() {
  if (active) {
    stopSession();
    setTimeout(deliberate, 350);
    return;
  }

  if (!utterances.length) {
    consensusBox.textContent =
      "No hay transcripción para deliberar. La grabación de audio no se transcribe sola en este navegador.";
    statusNode.textContent =
      "Estado: sin texto transcrito. Usa Chrome/Edge para transcripción automática.";
    return;
  }

  const topic = detectTopic(utterances);
  const pro = [];
  const con = [];
  const neutral = [];

  utterances.forEach((u) => {
    const label = classify(u.text);
    if (label === "pro") pro.push(u.text);
    else if (label === "con") con.push(u.text);
    else neutral.push(u.text);
  });

  const total = Math.max(1, pro.length + con.length + neutral.length);
  const support = Math.round((pro.length / total) * 100);
  const rejection = Math.round((con.length / total) * 100);
  const reservations = Math.max(0, 100 - support - rejection);
  const consensusReached = support >= 67;

  const proposal = consensusReached
    ? `Avanzar con acuerdo sobre ${topic}, incorporando mitigaciones para objeciones detectadas.`
    : `Abrir segunda ronda sobre ${topic}, enfocada en objeciones y ajustes de propuesta.`;

  consensusBox.innerHTML = [
    `<p><strong>Tema detectado:</strong> ${topic}</p>`,
    `<p><strong>Apoyo estimado:</strong> ${support}%</p>`,
    `<p><strong>Reservas:</strong> ${reservations}%</p>`,
    `<p><strong>Rechazo estimado:</strong> ${rejection}%</p>`,
    `<p><strong>Consenso:</strong> ${consensusReached ? "alcanzado" : "pendiente"}</p>`,
    `<p><strong>Propuesta:</strong> ${proposal}</p>`,
    `<p><strong>Argumento clave a favor:</strong> ${pro[0] || "sin datos"}</p>`,
    `<p><strong>Objeción principal:</strong> ${con[0] || "sin datos"}</p>`
  ].join("");

  deliberations.unshift({
    topic,
    proposal,
    meta: `Apoyo ${support}% · Reservas ${reservations}% · Rechazo ${rejection}%`
  });
  saveState();
  renderList();
}

function renderList() {
  listNode.innerHTML = "";
  if (!deliberations.length) {
    listNode.textContent = "Sin deliberaciones.";
    return;
  }

  deliberations.forEach((entry) => {
    const fragment = itemTemplate.content.cloneNode(true);
    fragment.querySelector(".topic").textContent = entry.topic;
    fragment.querySelector(".proposal").textContent = entry.proposal;
    fragment.querySelector(".meta").textContent = entry.meta;
    listNode.appendChild(fragment);
  });
}

function startToneTracking(sourceStream) {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(sourceStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  toneBuffer = [];

  toneInterval = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    const frame = {
      pitch: estimatePitch(data, audioCtx.sampleRate),
      energy: rms(data)
    };
    toneBuffer.push(frame);
    if (toneBuffer.length > 12) toneBuffer.shift();
  }, 220);
}

async function startSession() {
  if (active) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      if (!audioChunks.length) return;
      const blob = new Blob(audioChunks, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      audioNode.src = url;
      downloadNode.href = url;
      downloadNode.download = `consensus-session-${Date.now()}.webm`;
      downloadNode.hidden = false;
      downloadNode.textContent = "Descargar audio";
    };
    mediaRecorder.start();

    startToneTracking(stream);

    if (SpeechRecognition) {
      recognition = new SpeechRecognition();
      recognition.lang = "es-ES";
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event) => {
        let finalText = "";
        let interimText = "";
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          if (event.results[i].isFinal) {
            finalText += `${event.results[i][0].transcript} `;
          } else {
            interimText += `${event.results[i][0].transcript} `;
          }
        }
        if (finalText.trim()) {
          appendUtterance(finalText);
          pendingInterimText = "";
        } else {
          pendingInterimText = interimText.trim();
        }
      };

      recognition.onerror = () => {
        statusNode.textContent = "Estado: grabando audio, transcripción parcial.";
      };

      recognition.onend = () => {
        flushPendingInterim();
      };

      recognition.start();
      statusNode.textContent = "Estado: grabando + transcribiendo";
    } else {
      statusNode.textContent = "Estado: grabando (sin transcripción automática en este navegador)";
    }

    active = true;
  } catch {
    statusNode.textContent = "Estado: no hay acceso al micrófono.";
  }
}

function stopSession() {
  if (!active) return;

  flushPendingInterim();
  if (recognition) recognition.stop();
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  if (stream) stream.getTracks().forEach((t) => t.stop());

  if (toneInterval) clearInterval(toneInterval);
  if (audioCtx && audioCtx.state !== "closed") audioCtx.close();

  active = false;
  statusNode.textContent = "Estado: sesión detenida";
}

function clearAll() {
  stopSession();
  utterances = [];
  deliberations = [];
  speakerProfiles = [];
  speakerCounter = 1;
  lastSpeakerId = undefined;
  toneBuffer = [];
  pendingInterimText = "";

  transcriptBox.textContent = "Sin transcripción.";
  consensusBox.textContent = "Sin síntesis.";
  listNode.textContent = "Sin deliberaciones.";

  audioNode.removeAttribute("src");
  downloadNode.hidden = true;
  localStorage.removeItem(STORAGE_KEY);
  statusNode.textContent = "Estado: limpio";
}

startBtn.addEventListener("click", startSession);
stopBtn.addEventListener("click", stopSession);
analyzeBtn.addEventListener("click", deliberate);
clearBtn.addEventListener("click", clearAll);

renderTranscript();
consensusBox.textContent = "Sin síntesis.";
renderList();
