"""보안 패치 의존성의 실제 사용 경로 호환성 검증."""

from __future__ import annotations

import io
import unittest

import click
import idna
from click.testing import CliRunner
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.testclient import TestClient
from PIL import Image


app = FastAPI()


@app.post("/urlencoded")
def urlencoded(name: str = Form(...)):
    return {"name": name}


@app.post("/multipart")
async def multipart(label: str = Form(...), file: UploadFile = File(...)):
    data = await file.read()
    return {"label": label, "filename": file.filename, "size": len(data)}


@click.command()
@click.option("--name", required=True)
def _sample_command(name: str) -> None:
    click.echo(name)


class SecurityDependencyCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app, client=("127.0.0.1", 50000))

    @classmethod
    def tearDownClass(cls):
        cls.client.close()

    def test_normal_urlencoded_form_still_works(self):
        response = self.client.post("/urlencoded", data={"name": "정상 입력"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"name": "정상 입력"})

    def test_excessive_urlencoded_fields_are_rejected(self):
        body = "name=ok&" + "&".join(f"f{i}=v" for i in range(1001))
        response = self.client.post(
            "/urlencoded",
            content=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        self.assertEqual(response.status_code, 400, response.text)

    def test_multipart_file_upload_still_works(self):
        response = self.client.post(
            "/multipart",
            data={"label": "이미지"},
            files={"file": ("sample.png", b"png-bytes", "image/png")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            response.json(),
            {"label": "이미지", "filename": "sample.png", "size": 9},
        )

    def test_pillow_image_roundtrip_and_thumbnail(self):
        source = io.BytesIO()
        Image.new("RGB", (64, 32), (10, 20, 30)).save(source, format="PNG")
        source.seek(0)
        with Image.open(source) as image:
            image.load()
            image.thumbnail((16, 16))
            self.assertEqual(image.size, (16, 8))

    def test_idna_and_click_normal_paths_still_work(self):
        self.assertEqual(idna.decode(idna.encode("예시.한국")), "예시.한국")
        result = CliRunner().invoke(_sample_command, ["--name", "정상"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.assertEqual(result.output.strip(), "정상")

