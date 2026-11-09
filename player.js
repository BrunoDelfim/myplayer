#!/usr/bin/env node

const { spawn, execFileSync } = require('child_process');
const readline = require('readline');
const net = require('net');
const fs = require('fs');

// Gerenciamento independente do visualizador.
let visualizerProcess = null;
const visualizerSocketPath = `/tmp/myplayer-visualizer-${process.pid}.sock`;
// Gerenciamento do roteamento de áudio
let audioSinkModuleId = null;
let audioLoopbackModuleId = null;

function startAudioRouting() {
    if (audioSinkModuleId && audioLoopbackModuleId) {
        return;
    }

    try {
        const defaultSink = execFileSync(
            'pactl',
            ['get-default-sink'],
            { encoding: 'utf8' }
        ).trim();

        if (!defaultSink) {
            throw new Error('Não foi possível identificar a saída de áudio padrão.');
        }

        // Cria o dispositivo virtual
        audioSinkModuleId = execFileSync(
            'pactl',
            [
                'load-module',
                'module-null-sink',
                'sink_name=myplayer_sink',
                'sink_properties=device.description=MyPlayer'
            ],
            { encoding: 'utf8' }
        ).trim();

        // Encaminha o áudio para a saída física
        audioLoopbackModuleId = execFileSync(
            'pactl',
            [
                'load-module',
                'module-loopback',
                'source=myplayer_sink.monitor',
                `sink=${defaultSink}`,
                'latency_msec=20'
            ],
            { encoding: 'utf8' }
        ).trim();

        console.log('🔊 Roteamento de áudio ativado.');

    } catch (error) {
        stopAudioRouting();
        throw new Error(`Falha ao configurar o áudio: ${error.message}`);
    }
}

function stopAudioRouting() {
    // Remove primeiro o loopback
    if (audioLoopbackModuleId) {
        try {
            execFileSync('pactl', [
                'unload-module',
                audioLoopbackModuleId
            ]);
        } catch {}

        audioLoopbackModuleId = null;
    }

    // Depois remove o dispositivo virtual
    if (audioSinkModuleId) {
        try {
            execFileSync('pactl', [
                'unload-module',
                audioSinkModuleId
            ]);
        } catch {}

        audioSinkModuleId = null;
    }
}

// Encerramento seguro do MyPlayer
let isShuttingDown = false;

function handleShutdown(signal) {
    if (isShuttingDown) return;

    isShuttingDown = true;

    console.log('\n🛑 Encerrando MyPlayer...');

    stopVisualizer();

    // Remove o roteamento de áudio
    stopAudioRouting();

    // Restaura o terminal, caso esteja em modo raw
    if (process.stdin.isTTY &&
        typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(false);
    }

    const exitCodes = {
        SIGINT: 130,
        SIGTERM: 143,
        SIGHUP: 129
    };

    process.exit(exitCodes[signal] || 1);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGHUP', () => handleShutdown('SIGHUP'));

function sendVisualizerTitle(title, attempt = 0) {
    if (!visualizerProcess) return;

    const client = net.createConnection(visualizerSocketPath);

    client.once('connect', () => {
        console.log('[DEBUG] IPC conectado.');
        client.write(`${title}\n`);
        client.end();
    });

    client.once('error', () => {
        client.destroy();

        if (attempt < 20 && visualizerProcess) {
            setTimeout(() => {
                sendVisualizerTitle(title, attempt + 1);
            }, 100);
        }
    });
}

function startVisualizer(title) {
    if (
        visualizerProcess &&
        visualizerProcess.exitCode === null &&
        visualizerProcess.signalCode === null
    ) {
        sendVisualizerTitle(title);
        return;
    }

    try {
          fs.writeFileSync(
              '/tmp/myplayer-cava-raw.conf',
              `[general]
              framerate = 60
              bars = 32
              sensitivity = 350
              autosens = 0
              sleep_timer = 0

              [input]
              method = pulse
              source = myplayer_sink.monitor

              [output]
              method = raw
              raw_target = /tmp/myplayer-cava.raw
              data_format = ascii
              channels = mono
              `
          );
      } catch (error) {
          console.error(
              'Erro ao criar configuração do CAVA:',
              error.message
          );
          return;
      }

    const child = spawn(
        'python3',
        [
            `${__dirname}/visualizer/visualizer.py`,
            title,
            visualizerSocketPath
        ],
        { stdio: 'inherit' }
    );

    visualizerProcess = child;

    child.once('error', (error) => {
        console.error('Erro ao iniciar o visualizador:', error.message);

        if (visualizerProcess === child) {
            visualizerProcess = null;
        }
    });

    child.once('close', () => {
        if (visualizerProcess === child) {
            visualizerProcess = null;
        }
    });
}


function stopVisualizer() {
    const child = visualizerProcess;
    visualizerProcess = null;

    if (
        !child ||
        child.exitCode !== null ||
        child.signalCode !== null
    ) {
        return;
    }

    // Solicita ao Python que feche o Qt normalmente.
    child.kill('SIGUSR1');

    // Aguarda até 2 segundos antes de forçar o encerramento.
    const forceKill = setTimeout(() => {
        if (
            child.exitCode === null &&
            child.signalCode === null
        ) {
            child.kill('SIGTERM');
        }
    }, 2000);

    child.once('close', () => {
        clearTimeout(forceKill);
    });
}


// Cores ANSI
const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    bgCyan: '\x1b[44m',
    black: '\x1b[97m'
};

// Histórico de vídeos reproduzidos nesta execução
const playedVideos = new Set();
const playedTitles = [];

// Detecta se o título do vídeo indica que é um álbum completo
// Converte duração em segundos, aceitando números e formatos HH:MM:SS.
function parseDuration(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }

    if (!value) return 0;

    const text = String(value).trim();

    if (/^\d+$/.test(text)) {
        return Number(text);
    }

    const parts = text.split(':').map(Number);

    if (parts.some(part => !Number.isFinite(part))) {
        return 0;
    }

    return parts.reduce((total, part) => total * 60 + part, 0);
}

// Identifica álbuns completos e coletâneas longas.
function isAlbumVideo(title, duration = 0) {
    const albumPatterns = [
        /\bfull album\b/i,
        /\bcomplete album\b/i,
        /\bentire album\b/i,
        /\balbum completo\b/i,
        /\bálbum completo\b/i,
        /\bálbum inteiro\b/i,
        /\bdisco completo\b/i,
        /\bfull discography\b/i,
        /\bdiscografia completa\b/i,
        /\bfull lp\b/i
    ];

    if (albumPatterns.some(pattern => pattern.test(title))) {
        return true;
    }

    const explicitCollectionPatterns = [
        /\brecorda[cç][oõ]es\b/i,
        /\bas antigas\b/i,
        /\bas melhores\b/i,
        /\bs[oó]\s+recorda[cç][oõ]es\b/i,
        /\bmelhores\s+da\s+hist[oó]ria\b/i,
        /\bgrandes\s+sucessos\b/i,
        /\bsucessos\s+antigos\b/i
    ];

    if (explicitCollectionPatterns.some(pattern => pattern.test(title))) {
        return true;
    }

    const collectionPatterns = [
        /\bs[oó] as melhores\b/i,
        /\bas melhores selecionadas\b/i,
        /\bsele[cç][aã]o\b/i,
        /\bselecionadas\b/i,
        /\bgreatest hits\b/i,
        /\bbest of\b/i,
        /\bplaylist\b/i,
        /\bcolet[aâ]nea\b/i,
        /\bcompilado\b/i,
        /\bdiscografia\b/i,
        /\bmedley\b/i,
        /\bnon.?stop\b/i,
        /\bmix\b/i
    ];

    return duration > 720 &&
        collectionPatterns.some(pattern => pattern.test(title));
}

// Normaliza títulos para comparação
function normalizeTitle(title) {
    return title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\b(official video|official audio|lyrics|lyric video|remastered|4k|hd)\b/gi, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Verifica títulos iguais ou versões muito semelhantes
function areTitlesSimilar(titleA, titleB) {
    const a = normalizeTitle(titleA);
    const b = normalizeTitle(titleB);

    if (!a || !b) return false;
    if (a === b) return true;

    const ignoredWords = new Set([
        'official', 'video', 'audio', 'lyrics', 'lyric',
        'remastered', 'live', 'ao', 'vivo',
        'repertorio', 'atualizado', 'hitou', 'brasil'
    ]);

    const getTokens = (title) => new Set(
        title.split(/\s+/).filter(word =>
            word.length > 2 &&
            !ignoredWords.has(word) &&
            !/^\d+$/.test(word)
        )
    );

    const tokensA = getTokens(a);
    const tokensB = getTokens(b);

    const common = [...tokensA].filter(word => tokensB.has(word));

    if (common.length < 3) return false;

    const similarity = common.length /
        Math.min(tokensA.size, tokensB.size);

    return similarity >= 0.6;
}

// Executa yt-dlp de forma síncrona
// Mantido para a busca de recomendações do autoplay
function runYtDlp(args) {
    try {
        return execFileSync('yt-dlp', args, {
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024
        });
    } catch (error) {
        if (error.stderr) {
            const stderr = error.stderr.toString().trim();
            if (stderr) {
                throw new Error(stderr);
            }
        }

        throw error;
    }
}

// Executa yt-dlp de forma assíncrona
// Permite que a barra de carregamento seja animada
function runYtDlpAsync(args) {
    return new Promise((resolve, reject) => {
        const child = spawn('yt-dlp', args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let finished = false;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (data) => {
            stdout += data;

            if (stdout.length > 10 * 1024 * 1024) {
                if (finished) return;

                finished = true;
                child.kill();

                reject(
                    new Error('A saída da pesquisa excedeu o limite permitido.')
                );
            }
        });

        child.stderr.on('data', (data) => {
            stderr += data;
        });

        child.on('error', (error) => {
            if (finished) return;
            finished = true;
            reject(error);
        });

        child.on('close', (code) => {
            if (finished) return;
            finished = true;

            if (code === 0) {
                resolve(stdout);
            } else {
                reject(
                    new Error(
                        stderr.trim() || `yt-dlp terminou com código ${code}.`
                    )
                );
            }
        });
    });
}

// Animação de carregamento
async function withLoadingAnimation(message, task) {
    const trackSize = 24;
    const blockSize = 5;

    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    let frame = 0;
    let position = 0;
    let direction = 1;

    const interval = setInterval(() => {
        const track = Array(trackSize).fill('─');

        for (let i = 0; i < blockSize; i++) {
            const index = position + i;

            if (index < trackSize) {
                track[index] = '━';
            }
        }

        const bar =
            `${colors.gray}[` +
            `${colors.cyan}${track.join('')}` +
            `${colors.gray}]${colors.reset}`;

        const spinner =
            `${colors.cyan}${frames[frame]}${colors.reset}`;

        process.stdout.write(
            `\r\x1b[2K ${spinner} ${colors.bold}${message}${colors.reset} ${bar}`
        );

        frame = (frame + 1) % frames.length;

        position += direction;

        if (position >= trackSize - blockSize) {
            direction = -1;
        } else if (position <= 0) {
            direction = 1;
        }
    }, 80);

    try {
        return await task();
    } finally {
        clearInterval(interval);
        process.stdout.write('\r\x1b[2K');
    }
}

// Converte a saída do yt-dlp em vídeos
function parseVideos(output) {
    const lines = output.split(/\r?\n/);
    const videos = [];

    for (let i = 0; i + 3 < lines.length; i += 4) {
        const id = lines[i]?.trim();
        const title = lines[i + 1]?.trim();
        const uploader = lines[i + 2]?.trim();
        const duration = parseDuration(lines[i + 3]?.trim());

        if (id && title) {
            videos.push({
                id,
                title,
                uploader: uploader || 'Desconhecido',
                duration
            });
        }
    }

    return videos;
}

// Pesquisa inicial no YouTube
async function searchVideos(query, limit = 30) {
    const output = await runYtDlpAsync([
        `ytsearch${limit}:${query}`,
        '--flat-playlist',
        '--print', '%(id)s',
        '--print', '%(title)s',
        '--print', '%(uploader)s',
        '--print', '%(duration)s',
        '--no-warnings',
        '--quiet'
    ]);

    return parseVideos(output);
}

// Menu de seleção com paginação
function selectVideo(videos, pageSize = 10) {
    return new Promise((resolve, reject) => {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
            reject(
                new Error('A seleção interativa exige um terminal compatível.')
            );
            return;
        }

        const totalPages = Math.ceil(videos.length / pageSize);

        let selectedIndex = 0;
        let currentPage = 0;
        let finished = false;

        const previousRawMode = process.stdin.isRaw;

        readline.emitKeypressEvents(process.stdin);
        process.stdin.setRawMode(true);
        process.stdin.resume();

        // Entra na tela alternativa e esconde o cursor.
        process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');

        function render() {
            const start = currentPage * pageSize;
            const end = Math.min(start + pageSize, videos.length);

            const c = colors;

            const lines = [
                `${c.bold}${c.cyan}🎬 Selecione o que deseja reproduzir:${c.reset}`,
                '',
                `${c.yellow}Página ${c.bold}${currentPage + 1}/${totalPages}${c.reset} ${c.gray}|${c.reset} ` +
                `${c.blue}← →${c.reset} trocar página ${c.gray}|${c.reset} ` +
                `${c.blue}↑ ↓${c.reset} selecionar ${c.gray}|${c.reset} ` +
                `${c.green}Enter${c.reset} confirmar ${c.gray}|${c.reset} ` +
                `${c.red}Esc${c.reset} cancelar`,
                ''
            ];

            for (let i = start; i < end; i++) {
                const video = videos[i];
                const number = `[${i + 1}]`;
                const marker = i === selectedIndex ? '❯' : ' ';

                if (i === selectedIndex) {
                    lines.push(
                        `${c.bgCyan}${c.black}${c.bold} ${marker} ${number} ${video.title} (${video.uploader}) ${c.reset}`
                    );
                } else {
                    lines.push(
                        `   ${c.yellow}${number}${c.reset} ` +
                        `${c.white}${video.title}${c.reset} ` +
                        `${c.gray}(${video.uploader})${c.reset}`
                    );
                }
            }

            // Limpa a tela e redesenha o menu na mesma posição.
            process.stdout.write('\x1b[2J\x1b[H');
            process.stdout.write(lines.join('\n'));
        }

        function finish(result) {
            if (finished) return;

            finished = true;

            process.stdin.removeListener('keypress', onKeypress);

            process.stdin.setRawMode(previousRawMode);

            // Sai da tela alternativa e restaura o terminal.
            process.stdout.write('\x1b[?1049l\x1b[?25h\n');

            resolve(result);
        }

        function onKeypress(character, key) {
            if (!key) return;

            if (key.ctrl && key.name === 'c') {
                finish(null);
                return;
            }

            switch (key.name) {
                case 'up':
                    if (selectedIndex > 0) {
                        selectedIndex--;

                        currentPage = Math.floor(
                            selectedIndex / pageSize
                        );

                        render();
                    }
                    break;

                case 'down':
                    if (selectedIndex < videos.length - 1) {
                        selectedIndex++;

                        currentPage = Math.floor(
                            selectedIndex / pageSize
                        );

                        render();
                    }
                    break;

                case 'left':
                    if (currentPage > 0) {
                        currentPage--;
                        selectedIndex = currentPage * pageSize;
                        render();
                    }
                    break;

                case 'right':
                    if (currentPage < totalPages - 1) {
                        currentPage++;
                        selectedIndex = currentPage * pageSize;
                        render();
                    }
                    break;

                case 'return':
                    finish(videos[selectedIndex]);
                    break;

                case 'escape':
                    finish(null);
                    break;
            }
        }

        process.stdin.on('keypress', onKeypress);

        render();
    });
}

// Função auxiliar para rodar o mpv
function playMedia(videoUrl, title, uploader, hasVideoFlag) {
    return new Promise((resolve) => {
        const startupStart = Date.now();

        if (!hasVideoFlag) {
            startAudioRouting();
        }

        console.log(
            `[DEBUG] Preparação do áudio: ${Date.now() - startupStart} ms`
        );

        sendVisualizerTitle(title);

        console.log(`\n▶️ Reproduzindo: ${title} (${uploader})`);

        const socketPath = `/tmp/myplayer-mpv-${process.pid}.sock`;

        if (fs.existsSync(socketPath)) {
            fs.unlinkSync(socketPath);
        }

        const mpvArgs = [
            '--profile=fast',
            '--hwdec=vaapi',
            '--gpu-api=opengl',
            `--input-ipc-server=${socketPath}`,
            '--input-terminal=no',
            '--term-playing-msg=[DEBUG] MPV iniciou playback'
        ];

        if (!hasVideoFlag) {
            mpvArgs.push('--audio-device=pipewire/myplayer_sink');
        }

        if (hasVideoFlag) {
            mpvArgs.push(
                '--ytdl-format=bestvideo[height<=720][vcodec^=avc1]+bestaudio/best[height<=720]'
            );

            mpvArgs.push(
                '--msg-level=all=status,vd=error,ffmpeg/video=no,ffmpeg=no,vo/gpu-next/libplacebo=no'
            );
        } else {
            mpvArgs.push('--no-video');
            mpvArgs.push('--ytdl-format=bestaudio');
        }

       if (!hasVideoFlag) {
            mpvArgs.push(
                '--ytdl-raw-options-append=extractor-args=youtube:player_client=visionos,tv_samsung'
            );
        }
        mpvArgs.push(videoUrl);

        console.log(
            `[DEBUG] Tempo até iniciar MPV: ${Date.now() - startupStart} ms`
        );

        const mpv = spawn('mpv', mpvArgs, {
            stdio: ['ignore', 'inherit', 'inherit'],
            env: {
                ...process.env,
                LIBVA_DRIVER_NAME: 'i965'
            }
        });

        let ipc = null;
        let finished = false;
        let requestedAction = null;
        let inputHandler = null;
        let paused = false;
        let ipcBuffer = '';
        let playbackPosition = 0;
        let requestId = 0;
        let playbackStarted = false;

        const previousRawMode = Boolean(process.stdin.isRaw);

        function sendCommand(command, id = null) {
            if (!ipc || ipc.destroyed) return;

            const message = { command };

            if (id !== null) {
                message.request_id = id;
            }

            ipc.write(JSON.stringify(message) + '\n');
        }

        function showVolume() {
            const id = ++requestId;
            sendCommand(['get_property', 'volume'], id);
        }

        
        function activateControls() {
            if (!process.stdin.isTTY || !process.stdin.setRawMode) {
                console.log(
                    `${colors.yellow}⚠️ Terminal sem suporte aos controles interativos.${colors.reset}`
                );
                return;
            }

            readline.emitKeypressEvents(process.stdin);
            process.stdin.setRawMode(true);
            process.stdin.resume();

            console.log(
                `${colors.cyan}⌨️ Controles: p pausar/retomar | n próxima | b voltar | ← 10s atrás | → 10s à frente | +/- volume | v visualizador | q voltar ao prompt${colors.reset}`
            );

            inputHandler = (str, key) => {
                if (key?.ctrl && key.name === 'c') {
                    requestedAction = 'quit';
                    sendCommand(['quit']);
                    return;
                }

                // Retroceder 10 segundos.
                if (key.name === 'left') {
                    sendCommand(['seek', -10, 'relative']);
                    return;
                }

                // Avançar 10 segundos.
                if (key.name === 'right') {
                    sendCommand(['seek', 10, 'relative']);
                    return;
                }

                switch (str?.toLowerCase()) {
                    case 'n':
                        if (requestedAction) return;

                        requestedAction = 'next';
                        console.log('\n⏭️ Próximo vídeo solicitado...');
                        sendCommand(['quit']);
                        break;

                    case 'p':
                        paused = !paused;

                        sendCommand([
                            'set_property',
                            'pause',
                            paused
                        ]);

                        console.log(
                            paused
                                ? '\n⏸️ Reprodução pausada.'
                                : '\n▶️ Reprodução retomada.'
                        );
                        break;

                    case 'b':
                        if (requestedAction) return;

                        if (playbackPosition > 3) {
                            sendCommand(['seek', 0, 'absolute']);
                            playbackPosition = 0;

                            console.log('\n⏮️ Música reiniciada.');
                        } else {
                            requestedAction = 'previous';

                            console.log('\n⏮️ Voltando à música anterior...');
                            sendCommand(['quit']);
                        }
                        break;

                    case '+':
                        sendCommand(['add', 'volume', 5]);
                        showVolume();
                        break;

                    case '-':
                        sendCommand(['add', 'volume', -5]);
                        showVolume();
                        break;

                    case 'v':
                        startVisualizer(title);
                        console.log('\n📊 Visualizador aberto.');
                        break;

                    case 'q':
                        if (requestedAction) return;

                        requestedAction = 'quit';

                        console.log(
                            '\n⏹️ Encerrando reprodução e retornando ao prompt...'
                        );

                        sendCommand(['quit']);
                        break;
                }
            };

            process.stdin.on('keypress', inputHandler);
        }


        function connectIpc(attempt = 0) {
            if (finished) return;

            const client = net.createConnection(socketPath);

            const onError = () => {
                client.destroy();

                if (attempt < 40 && !finished) {
                    setTimeout(() => connectIpc(attempt + 1), 100);
                } else if (!finished) {
                    console.log(
                        `${colors.red}❌ Não foi possível conectar aos controles do MPV.${colors.reset}`
                    );
                }
            };

            client.once('error', onError);

            client.once('connect', () => {
                client.removeListener('error', onError);

                if (finished) {
                    client.destroy();
                    return;
                }

                ipc = client;
                ipc.on('error', () => {});

                ipc.on('data', (chunk) => {
                    ipcBuffer += chunk.toString();

                    const lines = ipcBuffer.split('\n');
                    ipcBuffer = lines.pop() || '';

                    for (const line of lines) {
                        if (!line.trim()) continue;

                        try {
                            const response = JSON.parse(line);

                            // Detecta o primeiro avanço da reprodução.
                           // Acompanha a posição atual da reprodução.
                            if (
                                response.event === 'property-change' &&
                                response.name === 'time-pos' &&
                                typeof response.data === 'number'
                            ) {
                                playbackPosition = response.data;

                                if (!playbackStarted) {
                                    playbackStarted = true;

                                    console.log(
                                        `[DEBUG] Tempo até iniciar a reprodução: ${Date.now() - startupStart} ms`
                                    );
                                }
                            }

                            if (
                                response.request_id &&
                                response.error === 'success' &&
                                typeof response.data === 'number'
                            ) {
                                console.log(
                                    `\n🔊 Volume: ${Math.round(response.data)}%`
                                );
                            }
                        } catch {
                            // Ignora mensagens IPC inválidas.
                        }
                    }
                });

                // Observa o avanço da posição da mídia.
                const observationId = ++requestId;

                sendCommand(
                    ['observe_property', observationId, 'time-pos'],
                    observationId
                );

                activateControls();
            });
        }

        function finish(code) {
            if (finished) return;
            finished = true;

            if (inputHandler) {
                process.stdin.removeListener('keypress', inputHandler);
            }

            if (process.stdin.isTTY && process.stdin.setRawMode) {
                process.stdin.setRawMode(previousRawMode);
            }

            if (ipc && !ipc.destroyed) {
                ipc.destroy();
            }

            if (fs.existsSync(socketPath)) {
                fs.unlinkSync(socketPath);
            }

            console.log('\n🏁 Reprodução finalizada.');

            resolve({
                code,
                action: requestedAction
            });
        }

        mpv.on('error', (error) => {
            console.error('\n❌ Erro ao iniciar o MPV:', error.message);
            finish(null);
        });

        mpv.on('close', (code) => {
            finish(code);
        });

        setTimeout(() => connectIpc(), 100);
    });
}

// Busca recomendações contextuais diretamente do YouTube
async function getRelatedVideos(videoId, currentTitle, isAudioMode) {
    try {
        const response = await fetch(
            'https://www.youtube.com/youtubei/v1/next?prettyPrint=false',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': 'https://www.youtube.com',
                    'Referer': `https://www.youtube.com/watch?v=${videoId}`,
                    'X-YouTube-Client-Name': '1',
                    'X-YouTube-Client-Version': '2.20260114.08.00'
                },
                body: JSON.stringify({
                    context: {
                        client: {
                            clientName: 'WEB',
                            clientVersion: '2.20260114.08.00',
                            hl: 'pt-BR',
                            gl: 'BR'
                        }
                    },
                    videoId,
                    contentCheckOk: true,
                    racyCheckOk: true
                }),
                signal: AbortSignal.timeout(15000)
            }
        );

        if (!response.ok) {
            throw new Error(`YouTube respondeu com HTTP ${response.status}`);
        }

        const data = await response.json();

        const results =
            data.playerOverlays
                ?.playerOverlayRenderer
                ?.endScreen
                ?.watchNextEndScreenRenderer
                ?.results || [];

        const videos = results
            .map(item => item.endScreenVideoRenderer)
            .filter(Boolean)
            .map(video => {
                const title =
                    video.title?.simpleText ||
                    video.title?.runs?.map(run => run.text).join('') ||
                    'Sem título';

                const uploader =
                    video.shortBylineText?.runs?.map(run => run.text).join('') ||
                    video.longBylineText?.runs?.map(run => run.text).join('') ||
                    video.ownerText?.runs?.map(run => run.text).join('') ||
                    'Desconhecido';

                return {
                    id: video.videoId || video.endpoint?.watchEndpoint?.videoId,
                    title,
                    uploader,
                    duration: parseDuration(
                        video.lengthText?.simpleText
                    )
                };
            })
            .filter(video => {

                if (!video.id || playedVideos.has(video.id)) {
                    return false;
                }

                if (video.id === videoId) {
                    return false;
                }

                if (playedTitles.some(title =>
                    areTitlesSimilar(title, video.title)
                )) {
                    return false;
                }

                // Restrições exclusivas do modo áudio.
                if (isAudioMode) {
                    if (video.duration === 0 || video.duration > 900) {
                        return false;
                    }

                    if (isAlbumVideo(video.title, video.duration)) {
                        return false;
                    }
                }

                return true;
            });

        // Remove possíveis IDs duplicados sem alterar a ordem do YouTube.
        return [
            ...new Map(videos.map(video => [video.id, video])).values()
        ];

    } catch (error) {
        console.error(
            '\n⚠️ Erro ao buscar recomendações do YouTube:',
            error.message
        );

        return [];
    }
}

function showHelp() {
    console.log(`
      ${colors.bold}${colors.cyan}────────────── MYPLAYER — AJUDA ──────────────${colors.reset}

      ${colors.green}-a${colors.reset}             Ativar modo áudio
      ${colors.magenta}-v${colors.reset}             Ativar modo vídeo
      ${colors.green}-a consulta${colors.reset}   Pesquisar em modo áudio
      ${colors.magenta}-v consulta${colors.reset}   Pesquisar em modo vídeo
      ${colors.yellow}-h${colors.reset}             Exibir esta ajuda
      ${colors.red}-q${colors.reset}             Encerrar o MyPlayer
      ${colors.yellow}-l=N${colors.reset}          Limitar resultados da pesquisa
      ${colors.gray}             Padrão: 30 resultados; páginas de 10.${colors.reset}

      ${colors.bold}${colors.cyan}Durante a reprodução:${colors.reset}
      ${colors.green}p${colors.reset}  Pausar / continuar
      ${colors.green}n${colors.reset}  Próxima faixa
      ${colors.green}b${colors.reset}  Reiniciar faixa / voltar à anterior
      ${colors.green}←${colors.reset}  Retroceder 10 segundos
      ${colors.green}→${colors.reset}  Avançar 10 segundos
      ${colors.green}+${colors.reset}  Aumentar volume
      ${colors.green}-${colors.reset}  Diminuir volume
      ${colors.green}v${colors.reset}  Abrir visualizador
      ${colors.green}q${colors.reset}  Voltar ao prompt

      ${colors.gray}No prompt, letras sem prefixo são termos de pesquisa.${colors.reset}
    `);
}

function askCommand() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question(
            `\n${colors.bold}${colors.cyan}myplayer${colors.reset}> `,
            (answer) => {
                rl.close();
                resolve(answer.trim());
            }
        );
    });
}

// Função principal
async function main() {
    const args = process.argv.slice(2);

    let hasVideoFlag = args.includes('-v') ||
                       args.includes('--video');

    let cleanArgs = args.filter(arg =>
        !['-v', '--video', '-a', '--audio'].includes(arg)
    );

    let initialQuery = cleanArgs.join(' ').trim();

    async function executeSearch(query) {
      try {
          const limitMatches = [
              ...query.matchAll(/(?:^|\s)-l=([^\s]+)/gi)
          ];

          if (limitMatches.length > 1) {
              console.log(
                  `${colors.red}❌ Informe apenas um limite por pesquisa.${colors.reset}`
              );
              return;
          }

          let limit = 30;

          if (limitMatches.length === 1) {
              const value = limitMatches[0][1];

              if (!/^\d+$/.test(value) ||
                  !Number.isSafeInteger(Number(value)) ||
                  Number(value) < 1) {

                  console.log(
                      `${colors.red}❌ Limite inválido. Use um número inteiro maior que zero.${colors.reset}`
                  );
                  return;
              }

              limit = Number(value);
          }

          const searchQuery = query
              .replace(/(?:^|\s)-l=[^\s]+/gi, ' ')
              .replace(/\s+/g, ' ')
              .trim();

          if (!searchQuery) {
              console.log(
                  `${colors.red}❌ Informe o que deseja pesquisar.${colors.reset}`
              );
              return;
          }
            console.log(
                hasVideoFlag
                    ? `\n${colors.bold}${colors.magenta}🎬 MYPLAYER — MODO VÍDEO${colors.reset}`
                    : `\n${colors.bold}${colors.green}🎵 MYPLAYER — MODO ÁUDIO${colors.reset}`
            );

            console.log(
                `${colors.blue}🔍 Pesquisando por "${searchQuery}"...${colors.reset}\n`
            );

            const videos = await withLoadingAnimation(
                'Buscando resultados',
                () => searchVideos(searchQuery, limit)
            );

            if (videos.length === 0) {
                console.log(`${colors.red}❌ Nenhum resultado encontrado.${colors.reset}`);
                return;
            }

            console.log(
                `${colors.bold}${colors.green}✓ ${videos.length} resultados encontrados.${colors.reset}\n`
            );

            const selectedVideo = await selectVideo(videos, 10);

            if (!selectedVideo) {
                console.log(
                    `${colors.yellow}✓ Seleção cancelada.${colors.reset}`
                );
                return;
            }

            let currentVideo = selectedVideo;
            let isFirstPlayback = true;

            const playbackHistory = [selectedVideo];
            let historyIndex = 0;
            let replayingHistory = false;

            // LOOP DE AUTOPLAY
            while (currentVideo) {
              if (
                    !isFirstPlayback &&
                    !replayingHistory &&
                    playedVideos.has(currentVideo.id)
                ) {
                    console.log('\n⚠ Vídeo já reproduzido.');
                    break;
                }

                if (!playedVideos.has(currentVideo.id)) {
                    playedVideos.add(currentVideo.id);
                    playedTitles.push(currentVideo.title);
                }

                isFirstPlayback = false;
                replayingHistory = false;

                const videoUrl =
                    `https://www.youtube.com/watch?v=${currentVideo.id}`;
                    
                console.log(`[DEBUG] Video ID: ${currentVideo.id}`);

                const playback = await playMedia(
                    videoUrl,
                    currentVideo.title,
                    currentVideo.uploader,
                    hasVideoFlag
                );

                // O usuário encerrou a sessão de reprodução.
                if (playback.action === 'quit') {
                    console.log('✓ Retornando ao MyPlayer.');
                    break;
                }

                // Volta para a música anterior.
                if (playback.action === 'previous') {
                    if (historyIndex > 0) {
                        historyIndex--;
                    }

                    currentVideo = playbackHistory[historyIndex];
                    replayingHistory = true;

                    continue;
                }

                // Interrompe em caso de erro no MPV.
                if (playback.action !== 'next' && playback.code !== 0) {
                    if (playback.code !== null) {
                        console.log(
                            `⚠️ MPV finalizado com código ${playback.code}.`
                        );
                    }
                    break;
                }

                if (playback.action === 'next') {
                    console.log('⏭️ Buscando o próximo vídeo solicitado...');
                } else {
                    console.log(
                        '🔄 Buscando próximas sugestões reais (Autoplay)...'
                    );
                }

                const related = await withLoadingAnimation(
                    'Buscando recomendações do YouTube',
                    () => getRelatedVideos(
                        currentVideo.id,
                        currentVideo.title,
                        !hasVideoFlag
                    )
                );

                if (related.length === 0) {
                    console.log(
                        '❌ Nenhuma sugestão nova encontrada para continuar o autoplay.'
                    );
                    break;
                }

                console.log(
                    '⏭️ Autoplay ativado: Tocando a próxima faixa recomendada...'
                );

                currentVideo = related[0];

                // Se o usuário voltou no histórico e avançou novamente,
                // descarta o trecho posterior da navegação.
                playbackHistory.splice(historyIndex + 1);

                playbackHistory.push(currentVideo);
                historyIndex = playbackHistory.length - 1;
            }

        } catch (error) {
            if (error.isTtyError) {
                console.log('❌ O ambiente não suporta prompts interativos.');
            } else {
                console.error(
                    `\n${colors.red}❌ Erro na execução:${colors.reset}`,
                    error.message
                );
            }
        } finally {
            // Encerra o histórico da sessão de reprodução atual.
            playedVideos.clear();
            playedTitles.length = 0;

            stopVisualizer();
            stopAudioRouting();
        }
    }

    console.log(
        `\n${colors.bold}${colors.cyan}╭─────────────── MYPLAYER ────────────────╮${colors.reset}`
    );

    console.log(
        `${colors.bold}${colors.cyan}│${colors.reset}  ${colors.green}[-A]${colors.reset} Áudio    ${colors.magenta}[-V]${colors.reset} Vídeo    ${colors.red}[-Q]${colors.reset} Sair  ${colors.bold}${colors.cyan}│${colors.reset}`
    );

    console.log(
        `${colors.bold}${colors.cyan}╰─────────────────────────────────────────╯${colors.reset}`
    );

    let firstRun = true;

    while (true) {
        let command;

        if (firstRun && initialQuery) {
            command = initialQuery;
        } else {
            command = await askCommand();
        }

        firstRun = false;

        if (!command) {
            continue;
        }

        const normalized = command.toLowerCase();

        // Ajuda
        if (normalized === '-h' || normalized === '--help') {
            showHelp();
            continue;
        }

        // Encerrar
        if (normalized === '-q' || normalized === '--quit') {
            console.log(
                `\n${colors.green}👋 Até a próxima!${colors.reset}`
            );
            break;
        }

        // Alterar para áudio
        if (normalized === '-a' || normalized === '--audio') {
            hasVideoFlag = false;
            console.log(`${colors.green}🎵 Modo Áudio ativado.${colors.reset}`);
            continue;
        }

        // Alterar para vídeo
        if (normalized === '-v' || normalized === '--video') {
            hasVideoFlag = true;
            console.log(`${colors.magenta}🎬 Modo Vídeo ativado.${colors.reset}`);
            continue;
        }

        // Permite usar o parâmetro junto da pesquisa
        if (
            normalized.startsWith('-v ') ||
            normalized.startsWith('--video ')
        ) {
            hasVideoFlag = true;
            command = command.replace(/^(-v|--video)\s+/i, '');
        } else if (
            normalized.startsWith('-a ') ||
            normalized.startsWith('--audio ')
        ) {
            hasVideoFlag = false;
            command = command.replace(/^(-a|--audio)\s+/i, '');
        }

        const query = command.trim();

        if (query) {
            await executeSearch(query);
        }
    }
}

main();