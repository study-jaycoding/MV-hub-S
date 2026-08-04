"""운영 서버 기동 옵션 회귀 테스트."""

import os
import unittest
from unittest import mock

import serve


class ServeConfigTests(unittest.TestCase):
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
                },
            ),
        ):
            serve.main()

        self.assertIsNone(config.call_args.kwargs["ws_ping_interval"])
        server.assert_called_once_with(fake_config)
        fake_server.run.assert_called_once_with(sockets=[fake_socket, fake_socket])


if __name__ == "__main__":
    unittest.main()
