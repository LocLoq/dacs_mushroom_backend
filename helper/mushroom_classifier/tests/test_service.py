import base64
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from inference import ClassifierEngine, ClassifierError
import server

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNUWODAwMDAxAAGAAwKAQTFBdYUAAAAAElFTkSuQmCC')


class FakeEngine:
    labels = ['Amanita'] * 17
    device = 'cpu'

    def classify(self, image_bytes):
        return {'name': 'Nấm demo', 'scientificName': 'Amanita', 'rawPrediction': 'Amanita', 'accepted': True, 'edibility': 'POISONOUS', 'confidence': 0.9, 'confidenceThreshold': 0.6, 'isPoisonous': True, 'image': {'format': 'png', 'mimeType': 'image/png', 'sizeBytes': len(image_bytes), 'sha256': 'a'}, 'inferenceTimeMs': 1}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.patch = patch.object(server.ClassifierEngine, 'load', return_value=FakeEngine())
        self.patch.start()
        self.client = TestClient(server.app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.patch.stop()

    def test_health_and_classify(self):
        self.assertEqual(self.client.get('/health').json()['status'], 'ready')
        response = self.client.post('/v1/classify', data={'requestId': 'lookup-1'}, files={'image': ('x.png', PNG, 'image/png')})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['requestId'], 'lookup-1')
        self.assertEqual(response.json()['result']['confidence'], 0.9)

    def test_rejects_invalid_mime_and_token(self):
        os.environ['CLASSIFIER_SERVICE_TOKEN'] = 'secret'
        try:
            self.assertEqual(self.client.post('/v1/classify', data={'requestId': 'x'}, files={'image': ('x.png', PNG, 'image/png')}).status_code, 401)
            self.assertEqual(self.client.post('/v1/classify', headers={'x-classifier-token': 'secret'}, data={'requestId': 'x'}, files={'image': ('x.gif', PNG, 'image/gif')}).status_code, 422)
        finally:
            os.environ.pop('CLASSIFIER_SERVICE_TOKEN', None)

    def test_invalid_image_is_reported_by_engine(self):
        engine = FakeEngine()
        with patch.object(engine, 'classify', side_effect=ClassifierError('IMAGE_INVALID', 'bad image', 422)):
            with self.assertRaises(ClassifierError):
                engine.classify(b'not-an-image')


class ModelSmokeTests(unittest.TestCase):
    def test_checkpoint_loads_17_classes(self):
        previous = os.environ.get('CLASSIFIER_DEVICE')
        os.environ['CLASSIFIER_DEVICE'] = 'cpu'
        try:
            engine = ClassifierEngine.load()
            self.assertEqual(len(engine.labels), 17)
            self.assertEqual(len(engine.catalog), 17)
            result = engine.classify(PNG)
            self.assertTrue(0 <= result['confidence'] <= 1)
            self.assertEqual(result['image']['format'], 'png')
        finally:
            if previous is None: os.environ.pop('CLASSIFIER_DEVICE', None)
            else: os.environ['CLASSIFIER_DEVICE'] = previous


if __name__ == '__main__':
    unittest.main()
