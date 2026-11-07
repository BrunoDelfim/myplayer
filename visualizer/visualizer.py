
import sys
import os
import time
import stat
import subprocess
import socket
import threading

from PySide6.QtCore import Qt, QTimer, QThread, Signal, QSettings, QRect
from PySide6.QtGui import QColor, QPainter, QFont
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
                            int(v)
                            for v in line.strip().split(";")
                            if v
                        ]

                        if len(values) == 32:
                            self.spectrum_received.emit(values)

                    except ValueError:
                        continue

        except OSError as error:
            print(f"Erro na leitura do CAVA: {error}")

    def stop(self):
        self.running = False

class TitleServer(threading.Thread):
    def __init__(self, socket_path, on_title):
        super().__init__(daemon=True)

        self.socket_path = socket_path
        self.on_title = on_title
        self.running = True
        self.server = None

    def run(self):
        try:
            if os.path.exists(self.socket_path):
                os.unlink(self.socket_path)

            self.server = socket.socket(
                socket.AF_UNIX,
                socket.SOCK_STREAM
            )

            self.server.bind(self.socket_path)
            self.server.listen(5)
            self.server.settimeout(0.5)

            while self.running:
                try:
                    connection, _ = self.server.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break

                with connection:
                    try:
                        data = b""

                        while b"\n" not in data:
                            chunk = connection.recv(4096)

                            if not chunk:
                                break

                            data += chunk

                        title = data.split(b"\n", 1)[0].decode(
                            "utf-8"
                        ).strip()

                        if title:
                            self.on_title(title)

                    except (OSError, UnicodeDecodeError):
                        continue

        except OSError as error:
            print(f"Erro no servidor de títulos: {error}")

        finally:
            if self.server:
                self.server.close()

            if os.path.exists(self.socket_path):
                os.unlink(self.socket_path)

    def stop(self):
        self.running = False

        if self.server:
            self.server.close()

        self.join(timeout=2)

class Visualizer(QWidget):
    title_received = Signal(str)

    def __init__(self, title="MyPlayer", socket_path=None):
        super().__init__()

        self.settings = QSettings("MyPlayer", "Visualizer")

        self.setWindowFlags(
            Qt.WindowType.Window
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
        )

        self.setAttribute(
            Qt.WidgetAttribute.WA_TranslucentBackground
        )

        self.setMinimumSize(320, 110)

        self.bar_count = 32
        self.segment_count = 16

        self.levels = [0.0] * self.bar_count
        self.targets = [0.0] * self.bar_count

        self.title = title

        self.title_received.connect(self.update_title)

        self.title_server = None

        if socket_path:
            self.title_server = TitleServer(
                socket_path,
                self.title_received.emit
            )

            self.title_server.start()


        self.marquee_offset = 0.0

        self.visualizer_modes = ["Barras XP"]
        self.mode_index = 0

        self.drag_offset = None
        self.native_drag = False

        self.resize(
            int(self.settings.value("width", 480)),
            int(self.settings.value("height", 160))
        )

        self.restore_position()

        self.start_cava()

        self.reader = CavaReader()
        self.reader.spectrum_received.connect(
            self.receive_spectrum
        )
        self.reader.start()

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.update_visualizer)
        self.timer.start(16)

    def restore_position(self):
        x = self.settings.value("x")
        y = self.settings.value("y")

        if x is not None and y is not None:
            x = int(x)
            y = int(y)

            saved_rect = QRect(
                x, y, self.width(), self.height()
            )

            for screen in QApplication.screens():
                if saved_rect.intersects(screen.availableGeometry()):
                    self.move(x, y)
                    return

        screen = QApplication.primaryScreen()
        area = screen.availableGeometry()

        margin = 18

        self.move(
            area.right() - self.width() - margin,
            area.bottom() - self.height() - margin
        )

    def save_position(self):
        if QApplication.platformName() != "wayland":
            self.settings.setValue("x", self.x())
            self.settings.setValue("y", self.y())

        if not self.isMaximized() and not self.isFullScreen():
            self.settings.setValue("width", self.width())
            self.settings.setValue("height", self.height())

        self.settings.sync()

    def start_cava(self):
        if os.path.exists(FIFO):
            if stat.S_ISFIFO(os.stat(FIFO).st_mode):
                os.unlink(FIFO)
            else:
                raise RuntimeError(
                    "O caminho do CAVA não é um FIFO."
                )

        self.cava = subprocess.Popen(
            ["cava", "-p", CONFIG],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )

        time.sleep(0.3)

        if self.cava.poll() is not None:
            raise RuntimeError("Não foi possível iniciar o CAVA.")

    def receive_spectrum(self, values):
        for i, value in enumerate(values):
            self.targets[i] = min(
                1.0, max(0.0, value / 1000)
            )

    def update_visualizer(self):
        for i in range(self.bar_count):
            target = self.targets[i]

            speed = 0.40 if target > self.levels[i] else 0.12

            self.levels[i] += (
                target - self.levels[i]
            ) * speed

        self.marquee_offset += 0.7
        self.update()

    def segment_color(self, position):
        if position < 0.45:
            return QColor("#00e83b")
        elif position < 0.72:
            return QColor("#eaff00")
        elif position < 0.88:
            return QColor("#ff9900")
        return QColor("#ff2020")

    def draw_title(self, painter):
        area_width = self.width() - 20
        title_y = 5
        title_height = 20

        font = QFont("Sans Serif")
        font.setPixelSize(10)

        painter.setFont(font)
        painter.setPen(QColor("#b8b8b8"))

        metrics = painter.fontMetrics()
        text_width = metrics.horizontalAdvance(self.title)

        painter.save()
        painter.setClipRect(
            10, title_y, area_width, title_height
        )

        if text_width <= area_width:
            painter.drawText(
                10,
                title_y,
                area_width,
                title_height,
                Qt.AlignmentFlag.AlignVCenter,
                self.title
            )
        else:
            gap = 55
            total = text_width + gap
            offset = self.marquee_offset % total

            painter.drawText(
                int(10 - offset),
                title_y,
                self.title
            )

            painter.drawText(
                int(10 - offset + total),
                title_y,
                self.title
            )

        painter.restore()

    def paintEvent(self, event):
        painter = QPainter(self)

        painter.setRenderHint(
            QPainter.RenderHint.Antialiasing, False
        )

        painter.fillRect(self.rect(), QColor("#000000"))

        self.draw_title(painter)

        horizontal_margin = 10
        vertical_margin = 8

        top_area = 27

        available_width = (
            self.width() - horizontal_margin * 2
        )

        available_height = (
            self.height() - top_area - vertical_margin
        )

        bar_width = available_width / self.bar_count
        gap = max(2, bar_width * 0.15)

        segment_gap = 2

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
                    self.height() - vertical_margin
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

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.RightButton:
            handle = self.windowHandle()

            if handle and handle.startSystemMove():
                self.native_drag = True
            else:
                self.native_drag = False
                self.drag_offset = (
                    event.globalPosition().toPoint()
                    - self.frameGeometry().topLeft()
                )

            event.accept()
            return

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.close()
            event.accept()

    def mouseMoveEvent(self, event):
        if (
            not self.native_drag
            and self.drag_offset is not None
            and event.buttons() & Qt.MouseButton.RightButton
        ):
            self.move(
                event.globalPosition().toPoint()
                - self.drag_offset
            )

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.RightButton:
            self.drag_offset = None
            self.native_drag = False
            self.save_position()

    def wheelEvent(self, event):
        direction = event.angleDelta().y()

        if direction:
            self.mode_index = (
                self.mode_index + (1 if direction > 0 else -1)
            ) % len(self.visualizer_modes)

            self.update()

        event.accept()

    def moveEvent(self, event):
        super().moveEvent(event)
        self.save_position()

    def resizeEvent(self, event):
        super().resizeEvent(event)

        if not self.isMaximized() and not self.isFullScreen():
            self.save_position()

    def closeEvent(self, event):
        self.save_position()

        if self.title_server:
            self.title_server.stop()

        self.timer.stop()

        self.reader.stop()

        if self.cava.poll() is None:
            self.cava.terminate()

        self.reader.wait(2000)

        if self.cava.poll() is None:
            self.cava.kill()
            self.cava.wait()

        event.accept()

    def update_title(self, title):
        self.title = title
        self.marquee_offset = 0.0
        self.update()


if __name__ == "__main__":
    title = sys.argv[1] if len(sys.argv) > 1 else "MyPlayer"
    socket_path = sys.argv[2] if len(sys.argv) > 2 else None

    app = QApplication(sys.argv)

    window = Visualizer(title, socket_path)
    window.show()

    sys.exit(app.exec())
