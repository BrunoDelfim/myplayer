import os
import time
import stat
import subprocess

FIFO = "/tmp/myplayer-cava.raw"
CONFIG = "/tmp/myplayer-cava-raw.conf"

if os.path.exists(FIFO):
    if stat.S_ISFIFO(os.stat(FIFO).st_mode):
        os.unlink(FIFO)
    else:
        raise RuntimeError("O caminho existe, mas não é um FIFO.")

cava = subprocess.Popen(
    ["cava", "-p", CONFIG],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL
)

try:
    while not os.path.exists(FIFO):
        if cava.poll() is not None:
            raise RuntimeError("O CAVA encerrou inesperadamente.")
        time.sleep(0.05)

    print("Conectado ao CAVA. Lendo espectro...\n")

    with open(FIFO, "r") as stream:
        for i in range(5):
            line = stream.readline()
            values = [int(v) for v in line.strip().split(";") if v]

            print(f"Leitura {i + 1}: {len(values)} barras")
            print(values)
            print()

finally:
    cava.terminate()
    cava.wait()
