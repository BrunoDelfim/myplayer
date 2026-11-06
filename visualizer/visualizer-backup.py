import sys
import os
import time
import stat
import subprocess

from PySide6.QtCore import Qt, QTimer, QThread, Signal
from PySide6.QtGui import QColor, QPainter
from PySide6.QtWidgets import QApplication, QWidget


FIFO = "/tmp/myplayer-cava.raw"
CONFIG = "/tmp/myplayer-cava-raw.conf"


class CavaReader(QThread):
    spectrum_received = Signal(list)

    def __init__(self):
        super().__init__()
        self.running = True

    def run(self):
        try:
            with open(FIFO, "r") as stream:
                while self.running:
                    line = stream.readline()

                    if not line:
                        break

                    try:
                        values = [
                            int(value)
                            for value in line.strip().split(";")
                            if value
                        ]

                        if len(values) == 32:
                            self.spectrum_received.emit(values)

                    except ValueError:
                        continue

        except OSError as error:
            print(f"Erro na leitura do CAVA: {error}")

    def stop(self):
        self.running = False


class Visualizer(QWidget):
    def __init__(self):
        super().__init__()

        self.setWindowTitle("MyPlayer Visualizer")
        self.resize(900, 420)
        self.setMinimumSize(400, 200)

        self.bar_count = 32
        self.segment_count = 24

        self.levels = [0.0] * self.bar_count
        self.targets = [0.0] * self.bar_count

        self.start_cava()

        self.reader = CavaReader()
        self.reader.spectrum_received.connect(self.receive_spectrum)
        self.reader.start()

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.update_visualizer)
        self.timer.start(16)

    def start_cava(self):
        if os.path.exists(FIFO):
            if stat.S_ISFIFO(os.stat(FIFO).st_mode):
                os.unlink(FIFO)
            else:
                raise RuntimeError(
                    f"{FIFO} existe, mas não é um FIFO."
                )

        self.cava = subprocess.Popen(
            ["cava", "-p", CONFIG],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )

        time.sleep(0.3)

        if self.cava.poll() is not None:
            raise RuntimeError(
                "O CAVA não iniciou. Verifique a configuração."
            )

    def receive_spectrum(self, values):
        for i, value in enumerate(values):
            self.targets[i] = min(1.0, max(0.0, value / 1000))

    def update_visualizer(self):
        for i in range(self.bar_count):
            target = self.targets[i]

            if target > self.levels[i]:
                speed = 0.40
            else:
                speed = 0.12

            self.levels[i] += (
                target - self.levels[i]
            ) * speed

        self.update()

    def segment_color(self, position):
        if position < 0.45:
            return QColor("#00e83b")
        elif position < 0.72:
            return QColor("#eaff00")
        elif position < 0.88:
            return QColor("#ff9900")
        else:
            return QColor("#ff2020")

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(
            QPainter.RenderHint.Antialiasing, False
        )

        painter.fillRect(self.rect(), QColor("#000000"))

        width = self.width()
        height = self.height()

        horizontal_margin = 12
        vertical_margin = 12

        available_width = width - horizontal_margin * 2
        available_height = height - vertical_margin * 2

        bar_width = available_width / self.bar_count
        gap = max(2, bar_width * 0.15)

        segment_gap = max(2, height * 0.008)

        segment_height = (
            available_height
            - (self.segment_count - 1) * segment_gap
        ) / self.segment_count

        for i, level in enumerate(self.levels):
            active_segments = round(
                level * self.segment_count
            )

            x = (
                horizontal_margin
                + i * bar_width
                + gap / 2
            )

            actual_width = bar_width - gap

            for segment in range(active_segments):
                y = (
                    height - vertical_margin
                    - (segment + 1)
                    * (segment_height + segment_gap)
                    + segment_gap
                )

                position = (
                    segment / max(1, self.segment_count - 1)
                )

                painter.fillRect(
                    int(x),
                    int(y),
                    max(1, int(actual_width)),
                    max(1, int(segment_height)),
                    self.segment_color(position)
                )

        painter.end()

    def closeEvent(self, event):
        self.timer.stop()

        self.reader.stop()

        if self.cava.poll() is None:
            self.cava.terminate()

        self.reader.wait(2000)

        if self.cava.poll() is None:
            self.cava.kill()
            self.cava.wait()

        event.accept()


if __name__ == "__main__":
    app = QApplication(sys.argv)

    window = Visualizer()
    window.show()

    sys.exit(app.exec())
