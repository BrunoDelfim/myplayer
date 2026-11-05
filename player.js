#!/usr/bin/env node
const { spawn, execSync } = require('child_process');

async function main() {
  const args = process.argv.slice(2);
  const hasVideoFlag = args.includes('-v') || args.includes('--video');
  
  const cleanArgs = args.filter(arg => arg !== '-v' && arg !== '--video');
  const query = cleanArgs.join(' ');

  if (!query) {
    console.log('⚠️ Uso correto:');
    console.log('   myplayer "nome da musica"         (Modo Áudio)');
    console.log('   myplayer -v "nome do video"       (Modo Vídeo / PiP)');
    process.exit(1);
  }

  try {
    console.log(`🔍 Buscando "${query}" (${hasVideoFlag ? 'Modo Vídeo/PiP' : 'Modo Áudio'})...`);

    // Usa o yt-dlp diretamente para buscar e retornar o link de stream e metadados em JSON
    // Isso evita o erro 403 porque o yt-dlp resolve o ecossistema interno do YouTube na mesma chamada
    const searchCommand = `yt-dlp "ytsearch1:${query}" --print "%(id)s" --print "%(title)s" --print "%(uploader)s" --no-warnings`;
    
    const output = execSync(searchCommand, { encoding: 'utf8' }).trim().split('\n');
    
    if (output.length < 3 || !output[0]) {
      console.log('❌ Nenhum resultado encontrado.');
      return;
    }

    const videoId = output[0];
    const videoTitle = output[1];
    const uploader = output[2];
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`▶️ Reproduzindo: ${videoTitle} (${uploader})`);

    // Configura os argumentos do mpv
    // Configura os argumentos base do mpv de forma limpa
    const mpvArgs = [
      '--profile=fast', 
      '--hwdec=auto'
    ];

if (hasVideoFlag) {
      // Prioriza H.264 (AVC) em vez de AV1 para economizar CPU e evitar erros de decodificação
      mpvArgs.push('--ytdl-format=bestvideo[height<=720][vcodec^=avc1]+bestaudio/best[height<=720]');
      // Opcional: silencia os logs ruidosos de ffmpeg/vulkan no terminal
      mpvArgs.push('--msg-level=ffmpeg=error,vulkan=error');
    } else {
      mpvArgs.push('--no-video');
      mpvArgs.push('--ytdl-format=bestaudio');
    }

    // Passa explicitamente para o mpv ignorar arquivos de configuração externa de ytdl
    mpvArgs.push('--ytdl-raw-options=');

    // A URL oficial do YouTube vai obrigatoriamente por último
    mpvArgs.push(videoUrl);

    // Inicia o mpv passando a URL oficial para o yt-dlp interno do player gerenciar o stream
    const mpv = spawn('mpv', mpvArgs, { stdio: 'inherit' });

    mpv.on('close', (code) => {
      console.log('\n🏁 Reprodução finalizada.');
    });

  } catch (error) {
    console.error('❌ Erro na execução. Certifique-se de que o `yt-dlp` e o `mpv` estão instalados no sistema.');
  }
}

main();