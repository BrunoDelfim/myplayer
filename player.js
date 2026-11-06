#!/usr/bin/env node

const { spawn, execFileSync } = require('child_process');
const inquirer = require('inquirer');

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

// Executa yt-dlp sem shell e sem timeout artificial
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
      mpvArgs.push('--msg-level=all=status,vd=error,ffmpeg/video=no,ffmpeg=no,vo/gpu-next/libplacebo=no');

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

      // Evita vídeos já reproduzidos
      if (playedVideos.has(video.id)) {
        return false;
      }

      // Evita a mesma música ou versões muito semelhantes
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

// Pesquisa inicial no YouTube
function searchVideos(query) {
  const output = runYtDlp([
    `ytsearch5:${query}`,
    '--print', '%(id)s',
    '--print', '%(title)s',
    '--print', '%(uploader)s',
    '--no-warnings'
  ]);

  return parseVideos(output);
}

// Função principal
async function main() {
  const args = process.argv.slice(2);

  const hasVideoFlag =
    args.includes('-v') || args.includes('--video');

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
    console.log(`🔍 Pesquisando por "${query}"...`);

    const videos = searchVideos(query);

    if (videos.length === 0) {
      console.log('❌ Nenhum resultado encontrado.');
      return;
    }

    const choices = videos.map((v, index) => ({
      name: `[${index + 1}] ${v.title} (${v.uploader})`,
      value: v
    }));

    choices.push(new inquirer.Separator());

    choices.push({
      name: '❌ Cancelar / Sair',
      value: null
    });

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedVideo',
        message: '🎬 Selecione o que deseja reproduzir:',
        choices,
        pageSize: 10
      }
    ]);

    if (!answers.selectedVideo) {
      console.log('Operação cancelada.');
      return;
    }

    currentVideo = answers.selectedVideo;

    // LOOP DE AUTOPLAY CONTÍNUO
    while (currentVideo) {

      // Proteção contra reprodução duplicada
      if (playedVideos.has(currentVideo.id)) {
        console.log('\n⚠️ Vídeo já reproduzido.');
        break;
      }

      playedVideos.add(currentVideo.id);

      const videoUrl =
        `https://www.youtube.com/watch?v=${currentVideo.id}`;

      // Toca o vídeo atual
      const exitCode = await playMedia(
        videoUrl,
        currentVideo.title,
        currentVideo.uploader,
        hasVideoFlag
      );

      // Encerra caso o MPV apresente uma falha
      if (exitCode !== 0) {
        if (exitCode !== null) {
          console.log(`⚠️ MPV finalizado com código ${exitCode}.`);
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

      // Mantém o comportamento original:
      // seleciona a primeira recomendação válida
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
        '❌ Erro na execução:',
        error.message
      );
    }
  }
}

main();