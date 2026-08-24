# Third-party notices

Luvoelle includes the following third-party components and model assets. This notice is informational; each upstream license remains controlling. Standard MIT and Apache-2.0 texts are included in [`LICENSES/`](LICENSES/), while dependency-specific copyright notices remain in their distributed packages.

| Component | Use | License | Upstream |
| --- | --- | --- | --- |
| Electron | Desktop runtime and Chromium distribution | MIT plus Chromium third-party notices | https://github.com/electron/electron |
| Koffi | Win32 and macOS native API bindings | MIT | https://github.com/Koromix/koffi |
| PaddleOCR PP-OCRv6 small detection and recognition models | Default offline OCR models | Apache License 2.0 | https://github.com/PaddlePaddle/PaddleOCR |
| ppu-paddle-ocr | PP-OCRv6 preprocessing, detection and recognition pipeline | MIT | https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr |
| ppu-ocv | Image-processing adapter used by ppu-paddle-ocr | MIT | https://github.com/PT-Perkasa-Pilar-Utama/ppu-ocv |
| ONNX Runtime / onnxruntime-node | Native ONNX inference runtime | MIT | https://github.com/microsoft/onnxruntime |
| @napi-rs/canvas | Native image canvas used by the OCR pipeline | MIT | https://github.com/Brooooooklyn/canvas |
| @techstark/opencv-js / OpenCV.js | Image-processing runtime | Apache License 2.0 | https://github.com/TechStark/opencv-js |
| Tesseract.js and Tesseract.js Core | Offline OCR fallback | Apache License 2.0 | https://github.com/naptha/tesseract.js |
| Tesseract `eng` and `chi_sim` traineddata | English and Simplified Chinese fallback data | Apache License 2.0 | https://github.com/tesseract-ocr/tessdata_best |

Build and test tooling such as Playwright and electron-builder is used to produce or verify Luvoelle but is not part of Luvoelle's own source license. Packaged Electron distributions also include Electron's `LICENSE` and `LICENSES.chromium.html` notices.

No OCR image is uploaded by the local PP-OCRv6 or Tesseract fallback paths. When the user enables GPT OCR enhancement, translation, visual analysis or image generation, the selected external provider's terms and privacy policy apply separately.
