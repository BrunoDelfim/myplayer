#!/usr/bin/env node

const { spawn, execFileSync } = require('child_process');
const readline = require('readline');

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

    const shorter = a.length <= b.length ? a : b;
    const longer = a.length > b.length ? a : b;

    return shorter.length >= 12 && longer.includes(shorter);
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

    for (let i = 0; i + 2 < lines.length; i += 3) {
        const id = lines[i]?.trim();
        const title = lines[i + 1]?.trim();
        const uploader = lines[i + 2]?.trim();

        if (id && title) {
            videos.push({
                id,
                title,
                uploader: uploader || 'Desconhecido'
            });
        }
    }

    return videos;
}

// Pesquisa inicial no YouTube
async function searchVideos(query) {
    const output = await runYtDlpAsync([
        `ytsearch30:${query}`,
        '--print', '%(id)s',
        '--print', '%(title)s',
        '--print', '%(uploader)s',
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
        console.log(`\n▶️ Reproduzindo: ${title} (${uploader})`);
        console.log(`💡 (Pressione 'q' para pular para o próximo ou fechar)`);

        const mpvArgs = [
            '--profile=fast',
            '--hwdec=vaapi',
            '--gpu-api=opengl'
        ];

        if (hasVideoFlag) {
            mpvArgs.push(
                '--ytdl-format=bestvideo[height<=720][vcodec^=avc1]+bestaudio/best[height<=720]'
            );

            // Silencia logs ruidosos de ffmpeg/vulkan
            mpvArgs.push(
                '--msg-level=all=status,vd=error,ffmpeg/video=no,ffmpeg=no,vo/gpu-next/libplacebo=no'
            );
        } else {
            mpvArgs.push('--no-video');
            mpvArgs.push('--ytdl-format=bestaudio');
        }

        // Mantido conforme o comportamento original
        mpvArgs.push('--ytdl-raw-options=');
        mpvArgs.push(videoUrl);

        const mpv = spawn('mpv', mpvArgs, {
            stdio: 'inherit',
            env: {
                ...process.env,
                LIBVA_DRIVER_NAME: 'i965'
            }
        });

        let finished = false;

        function finish(code) {
            if (finished) return;
            finished = true;

            console.log('\n🏁 Reprodução finalizada.');
            resolve(code);
        }

        mpv.on('error', (error) => {
            console.error('\n❌ Erro ao iniciar o MPV:', error.message);
            finish(null);
        });

        mpv.on('close', (code) => {
            finish(code);
        });
    });
}

// Busca vídeos relacionados filtrando duplicatas

// Busca recomendações contextuais diretamente do YouTube
async function getRelatedVideos(videoId, currentTitle) {
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
                    id: video.videoId ||
                        video.endpoint?.watchEndpoint?.videoId,
                    title,
                    uploader
                };
            })
            .filter(video => {
                if (!video.id || playedVideos.has(video.id)) {
                    return false;
                }

                if (video.id === videoId) {
                    return false;
                }

                if (areTitlesSimilar(currentTitle, video.title)) {
                    return false;
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

function askCommand(mode) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const modeLabel = mode ? 'VÍDEO' : 'ÁUDIO';

        rl.question(
            `\n${colors.bold}${colors.cyan}myplayer${colors.reset} ` +
            `${colors.gray}[${modeLabel}]${colors.reset}> `,
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
            console.log(
                hasVideoFlag
                    ? `\n${colors.bold}${colors.magenta}🎬 MYPLAYER — MODO VÍDEO${colors.reset}`
                    : `\n${colors.bold}${colors.green}🎵 MYPLAYER — MODO ÁUDIO${colors.reset}`
            );

            console.log(
                `${colors.blue}🔍 Pesquisando por "${query}"...${colors.reset}\n`
            );

            const videos = await withLoadingAnimation(
                'Buscando resultados',
                () => searchVideos(query)
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

            // LOOP DE AUTOPLAY
            while (currentVideo) {
                if (playedVideos.has(currentVideo.id)) {
                    console.log('\n⚠️ Vídeo já reproduzido.');
                    break;
                }

                playedVideos.add(currentVideo.id);

                const videoUrl =
                    `https://www.youtube.com/watch?v=${currentVideo.id}`;

                const exitCode = await playMedia(
                    videoUrl,
                    currentVideo.title,
                    currentVideo.uploader,
                    hasVideoFlag
                );

                if (exitCode !== 0) {
                    if (exitCode !== null) {
                        console.log(
                            `⚠️ MPV finalizado com código ${exitCode}.`
                        );
                    }
                    break;
                }

                console.log(
                    '🔄 Buscando próximas sugestões reais (Autoplay)...'
                );

                const related = await withLoadingAnimation(
                    'Buscando recomendações do YouTube',
                    () => getRelatedVideos(
                        currentVideo.id,
                        currentVideo.title
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
        }
    }

    console.log(
        `\n${colors.bold}${colors.cyan}╭────────────── MYPLAYER ──────────────╮${colors.reset}`
    );
    console.log(
        `${colors.bold}${colors.cyan}│${colors.reset}  ${colors.green}[A]${colors.reset} Áudio    ${colors.magenta}[V]${colors.reset} Vídeo    ${colors.red}[X]${colors.reset} Sair  ${colors.bold}${colors.cyan}│${colors.reset}`
    );
    console.log(
        `${colors.bold}${colors.cyan}╰─────────────────────────────────────╯${colors.reset}`
    );

    let firstRun = true;

    while (true) {
        let command;

        if (firstRun && initialQuery) {
            command = initialQuery;
        } else {
            command = await askCommand(hasVideoFlag);
        }

        firstRun = false;

        if (!command) {
            continue;
        }

        const normalized = command.toLowerCase();

        // Encerrar
        if (normalized === 'x') {
            console.log(
                `\n${colors.green}👋 Até a próxima!${colors.reset}`
            );
            break;
        }

        // Alterar para áudio
        if (normalized === 'a' || normalized === '-a') {
            hasVideoFlag = false;
            console.log(`${colors.green}🎵 Modo Áudio ativado.${colors.reset}`);
            continue;
        }

        // Alterar para vídeo
        if (normalized === 'v' || normalized === '-v') {
            hasVideoFlag = true;
            console.log(`${colors.magenta}🎬 Modo Vídeo ativado.${colors.reset}`);
            continue;
        }

        // Permite usar o parâmetro junto da pesquisa
        if (normalized.startsWith('-v ') ||
            normalized.startsWith('--video ')) {
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