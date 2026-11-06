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
                child.kill();
                reject(new Error('A saída da pesquisa excedeu o limite permitido.'));
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
    const frames = [
        '[=                   ]',
        '[==                  ]',
        '[====                ]',
        '[======              ]',
        '[========            ]',
        '[==========          ]',
        '[============        ]',
        '[==============      ]',
        '[================    ]',
        '[==================  ]',
        '[====================]'
    ];

    let frame = 0;

    const interval = setInterval(() => {
        process.stdout.write(
            `\r\x1b[2K⏳ ${message} ${frames[frame]}`
        );

        frame = (frame + 1) % frames.length;
    }, 100);

    process.stdout.write(`\r\x1b[2K⏳ ${message} ${frames[0]}`);

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

        // Salva a posição inicial do menu
        process.stdout.write('\x1b[?25l\x1b[s');

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

            process.stdout.write('\x1b[u\x1b[J');
            process.stdout.write(lines.join('\n'));
        }

        function finish(result) {
            if (finished) return;
            finished = true;

            process.stdin.removeListener('keypress', onKeypress);

            process.stdin.setRawMode(previousRawMode);
            process.stdout.write('\x1b[u\x1b[J\x1b[?25h\n');

            resolve(result);
        }

        function onKeypress(_character, key) {
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
function getRelatedVideos(videoId, currentTitle) {
    try {
        const output = runYtDlp([
            `https://www.youtube.com/watch?v=${videoId}`,
            '--print', '%(id)s',
            '--print', '%(title)s',
            '--print', '%(uploader)s',
            '--playlist-items', '2-8',
            '--no-warnings'
        ]);

        const videos = parseVideos(output);

        return videos.filter(video => {
            if (playedVideos.has(video.id)) {
                return false;
            }

            if (areTitlesSimilar(currentTitle, video.title)) {
                return false;
            }

            return true;
        });

    } catch (error) {
        console.error(
            '\n⚠️ Erro ao buscar recomendações:',
            error.message
        );

        return [];
    }
}

// Função principal
async function main() {
    const args = process.argv.slice(2);

    const hasVideoFlag = args.includes('-v') || args.includes('--video');

    const cleanArgs = args.filter(
        arg => arg !== '-v' && arg !== '--video'
    );

    const query = cleanArgs.join(' ').trim();

    if (!query) {
        console.log('⚠️ Uso correto:');
        console.log('   myplayer "nome da musica"         (Modo Áudio)');
        console.log('   myplayer -v "nome do video"       (Modo Vídeo / PiP)');
        process.exitCode = 1;
        return;
    }

    let currentVideo = null;

    try {
        // Identificação do modo
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
            console.log('❌ Nenhum resultado encontrado.');
            return;
        }

        console.log(
            `${colors.bold}${colors.green}✓ ${videos.length} resultados encontrados.${colors.reset}\n`
        );

        const selectedVideo = await selectVideo(videos, 10);

        if (!selectedVideo) {
            console.log(`${colors.yellow}Operação cancelada.${colors.reset}`);
            return;
        }

        currentVideo = selectedVideo;

        // LOOP DE AUTOPLAY CONTÍNUO
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

            const related = getRelatedVideos(
                currentVideo.id,
                currentVideo.title
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

        console.log(
            '\n👋 Valeu por usar o MyPlayer! Até a próxima.'
        );

    } catch (error) {
        if (error.isTtyError) {
            console.log(
                '❌ O ambiente não suporta prompts interativos.'
            );
        } else {
            console.error(
                '\n❌ Erro na execução:',
                error.message
            );
        }
    }
}

main();
