"""운영 서버 기동 옵션 회귀 테스트."""

import os
import signal
import unittest
from contextlib import redirect_stdout
from io import StringIO
from unittest import mock

import serve


class ServeConfigTests(unittest.TestCase):
    def test_help_exits_before_server_starts(self):
        output = StringIO()
        with (
            mock.patch.object(serve, "main") as main,
            redirect_stdout(output),
            self.assertRaises(SystemExit) as raised,
        ):
            serve.cli(["--help"])

        self.assertEqual(raised.exception.code, 0)
        self.assertIn("usage:", output.getvalue())
        main.assert_not_called()

    def test_protocol_ping_is_disabled_because_browser_sends_app_ping(self):
        fake_socket = mock.sentinel.socket
        fake_config = mock.sentinel.config
        fake_server = mock.Mock()

        with (
            mock.patch.object(serve, "_make_socket", return_value=fake_socket),
            mock.patch.object(serve.uvicorn, "Config", return_value=fake_config) as config,
            mock.patch.object(serve.uvicorn, "Server", return_value=fake_server) as server,
            mock.patch.dict(
                os.environ,
                {
                    "CONTENT_HUB_SSL_CERTFILE": "",
                    "CONTENT_HUB_SSL_KEYFILE": "",
                    "CONTENT_HUB_ACCESS_LOG": "",
                },
            ),
        ):
            serve.main()

        self.assertIsNone(config.call_args.kwargs["ws_ping_interval"])
        self.assertFalse(config.call_args.kwargs["access_log"])
        self.assertFalse(config.call_args.kwargs["use_colors"])
        server.assert_called_once_with(fake_config)
        fake_server.run.assert_called_once_with(sockets=[fake_socket, fake_socket])

    @unittest.skipUnless(os.name == "nt", "Windows SIGBREAK 전용 회귀 테스트")
    def test_ctrl_break_handler_is_restored_after_server_stops(self):
        fake_server = mock.Mock()
        original = signal.getsignal(signal.SIGBREAK)

        serve._run_server(fake_server, [mock.sentinel.socket])

        fake_server.run.assert_called_once_with(sockets=[mock.sentinel.socket])
        self.assertIs(signal.getsignal(signal.SIGBREAK), original)

    def test_lifespan_startup_failure_returns_nonzero_exit(self):
        fake_socket = mock.sentinel.socket
        fake_server = mock.Mock(started=False)

        with (
            mock.patch.object(serve, "_make_socket", return_value=fake_socket),
            mock.patch.object(serve.uvicorn, "Config", return_value=mock.sentinel.config),
            mock.patch.object(serve.uvicorn, "Server", return_value=fake_server),
            mock.patch.dict(
                os.environ,
                {
                    "CONTENT_HUB_SSL_CERTFILE": "",
                    "CONTENT_HUB_SSL_KEYFILE": "",
                    "CONTENT_HUB_ACCESS_LOG": "",
                },
            ),
        ):
            with self.assertRaisesRegex(SystemExit, "1"):
                serve.main()

        fake_server.run.assert_called_once_with(sockets=[fake_socket, fake_socket])

    def test_ctrl_c_after_clean_shutdown_is_not_reported_as_a_crash(self):
        fake_server = mock.Mock()
        fake_server.run.side_effect = KeyboardInterrupt

        serve._run_server(fake_server, [mock.sentinel.socket])

        fake_server.run.assert_called_once_with(sockets=[mock.sentinel.socket])


if __name__ == "__main__":
    unittest.main()
