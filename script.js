const FREQ_BIT_0 = 7000;
const FREQ_BIT_1 = 9000;
const FREQ_ACK   = 6000;

const PULSE_TIME = 0.07;
const ACK_TIME   = 0.05;
const ECHO_PAUSE = 120;
const TIMEOUT_MS = 700;

let audioCtx = null;
let isListening = false;

function logMsg(msg, isSuccess = false) {
    const logDiv = document.getElementById('log');
    if (!logDiv) return;
    const className = isSuccess ? 'class="success"' : '';
    logDiv.innerHTML += `<div ${className}>${msg}</div>`;
    logDiv.scrollTop = logDiv.scrollHeight;
}

async function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    }
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }
    return audioCtx;
}

function detectFrequency(samples, targetFreq, sampleRate) {
    let k = Math.round(samples.length * targetFreq / sampleRate);
    let w = (2 * Math.PI / samples.length) * k;
    let cosine = Math.cos(w);
    let sine = Math.sin(w);
    let coeff = 2 * cosine;
    let q0 = 0, q1 = 0, q2 = 0;

    for (let i = 0; i < samples.length; i++) {
        q0 = coeff * q1 - q2 + samples[i];
        q2 = q1;
        q1 = q0;
    }

    let real = (q1 - q2 * cosine);
    let imag = (q2 * sine);
    return Math.sqrt(real * real + imag * imag) / samples.length;
}

async function playTone(freq, durationSec) {
    const ctx = await getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.3, now);
    osc.start(now);
    
    gain.gain.setValueAtTime(0, now + durationSec);
    osc.stop(now + durationSec + 0.01);

    return new Promise(resolve => setTimeout(resolve, durationSec * 1000));
}

const btnSend = document.getElementById('btnSend');
if (btnSend) {
    btnSend.addEventListener('click', async () => {
        isListening = false;
        const ctx = await getAudioContext();
        const textInput = document.getElementById('textInput');
        const text = textInput ? textInput.value : "";
        if (!text) return;

        const cleanText = text.substring(0, 10);
        logMsg(`\nПередача: "${cleanText}"`);

        const lengthBits = cleanText.length.toString(2).padStart(4, '0');
        let dataBits = "";
        for (let i = 0; i < cleanText.length; i++) {
            dataBits += cleanText.charCodeAt(i).toString(2).padStart(8, '0');
        }

        const bitStream = lengthBits + dataBits;
        logMsg(`Битов в пакете: ${bitStream.length}`);

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } 
            });
        } catch (e) {
            logMsg(`[Ошибка] Микрофон передатчика недоступен: ${e.message}`);
            return;
        }

        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        const chunkBuffer = new Float32Array(analyser.fftSize);

        const waitForACK = () => {
            return new Promise((resolve) => {
                const startTime = Date.now();
                let handled = false;

                setTimeout(() => {
                    const timer = setInterval(() => {
                        if (handled) return;

                        analyser.getFloatTimeDomainData(chunkBuffer);
                        const ackPower = detectFrequency(chunkBuffer, FREQ_ACK, ctx.sampleRate);

                        if (ackPower > 0.01) {
                            handled = true;
                            clearInterval(timer);
                            chunkBuffer.fill(0);
                            resolve(true);
                        } else if (Date.now() - startTime > TIMEOUT_MS) {
                            handled = true;
                            clearInterval(timer);
                            resolve(false);
                        }
                    }, 10);
                }, 40);
            });
        };

        for (let i = 0; i < bitStream.length; i++) {
            const bit = bitStream[i];
            const freq = (bit === '1') ? FREQ_BIT_1 : FREQ_BIT_0;
            let success = false;
            let retries = 0;

            while (!success && retries < 5) {
                logMsg(`Бит ${i + 1}/${bitStream.length} ('${bit}')...`);
                
                await playTone(freq, PULSE_TIME);
                const ackReceived = await waitForACK();
                
                if (ackReceived) {
                    success = true;
                    logMsg(`ACK получен!`);
                    await new Promise(r => setTimeout(r, ECHO_PAUSE));
                } else {
                    retries++;
                    logMsg(`Таймаут! Повтор бита (${retries}/5)...`);
                    await new Promise(r => setTimeout(r, 150));
                }
            }

            if (!success) {
                logMsg(`[Сбой] Потеря связи на бите ${i + 1}.`);
                return;
            }
        }

        logMsg(`[УСПЕХ] Все биты успешно доставлены!`, true);
    });
}

const btnListen = document.getElementById('btnListen');
if (btnListen) {
    btnListen.addEventListener('click', async () => {
        const ctx = await getAudioContext();
        logMsg(`\nПриемник активен...`);

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } 
            });
        } catch (err) {
            logMsg(`[Ошибка] Микрофон недоступен: ${err.message}`);
            return;
        }

        logMsg(`Слушаем эфир...`);

        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);

        const chunkBuffer = new Float32Array(analyser.fftSize);
        
        let receivedBits = "";
        let expectedCharCount = 0;
        let expectedTotalBits = 0;
        isListening = true;

        while (isListening) {
            analyser.getFloatTimeDomainData(chunkBuffer);

            const p0 = detectFrequency(chunkBuffer, FREQ_BIT_0, ctx.sampleRate);
            const p1 = detectFrequency(chunkBuffer, FREQ_BIT_1, ctx.sampleRate);

            const isBit0 = p0 > 0.012 && p0 > p1 * 2;
            const isBit1 = p1 > 0.012 && p1 > p0 * 2;

            if (isBit0 || isBit1) {
                const bit = isBit1 ? "1" : "0";
                receivedBits += bit;
                logMsg(`Бит №${receivedBits.length}: '${bit}'`);

                await new Promise(r => setTimeout(r, 70));

                await playTone(FREQ_ACK, ACK_TIME);

                if (receivedBits.length === 4) {
                    expectedCharCount = parseInt(receivedBits, 2);
                    if (expectedCharCount > 0 && expectedCharCount <= 10) {
                        expectedTotalBits = 4 + (expectedCharCount * 8);
                        logMsg(`Длина: ${expectedCharCount} симв. (${expectedTotalBits} бит)`);
                    } else {
                        logMsg(`[Ошибка] Искажение длины. Сброс.`);
                        receivedBits = "";
                        expectedTotalBits = 0;
                    }
                }

                if (expectedTotalBits > 0 && receivedBits.length >= expectedTotalBits) {
                    logMsg(`Пакет получен полностью!`);
                    decodeBits(receivedBits.substring(4));
                    receivedBits = "";
                    expectedTotalBits = 0;
                    isListening = false;
                    break;
                }

                await new Promise(r => setTimeout(r, ECHO_PAUSE));
                chunkBuffer.fill(0);
            } else {
                await new Promise(r => setTimeout(r, 10));
            }
        }
    });
}

function decodeBits(payloadBits) {
    let text = "";
    for (let i = 0; i < payloadBits.length; i += 8) {
        let byteStr = payloadBits.substring(i, i + 8);
        let charCode = parseInt(byteStr, 2);
        
        if (charCode >= 32 && charCode <= 126) {
            text += String.fromCharCode(charCode);
        }
    }

    if (text.length > 0) {
        logMsg(`[УСПЕХ] Текст: "${text}"`, true);
    } else {
        logMsg(`[Ошибка] Ошибка декодирования.`);
    }
}
