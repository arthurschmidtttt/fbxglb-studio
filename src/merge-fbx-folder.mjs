import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as THREE from 'three';
import { PNG } from 'pngjs';

const blobRegistry = new Map();
let blobCounter = 0;
let currentTextureBaseDir = '';
let currentTextureBaseStem = '';

function decodeDataUrl(url) {
  const match = /^data:([^;]+)?;base64,(.*)$/s.exec(url);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1] || 'application/octet-stream',
    buffer: Buffer.from(match[2], 'base64')
  };
}

function decodeImageBuffer(buffer) {
  try {
    const png = PNG.sync.read(buffer);
    return {
      width: png.width,
      height: png.height,
      data: Buffer.from(png.data)
    };
  } catch {
    return null;
  }
}

function decodeTextureUrl(url) {
  if (typeof url === 'string' && url.startsWith('blob:')) {
    const blob = blobRegistry.get(url.slice(5));
    if (blob) {
      return blob.arrayBuffer().then((arrayBuffer) => decodeImageBuffer(Buffer.from(arrayBuffer)));
    }
  } else if (typeof url === 'string' && url.startsWith('data:')) {
    const decoded = decodeDataUrl(url);
    return Promise.resolve(decoded?.buffer ? decodeImageBuffer(decoded.buffer) : null);
  } else if (typeof url === 'string') {
    const cleaned = (() => {
      try {
        return decodeURIComponent(url.split('?')[0].split('#')[0]);
      } catch {
        return url.split('?')[0].split('#')[0];
      }
    })();

    const normalized = cleaned.replace(/\//g, path.sep).replace(/\\/g, path.sep);
    const candidates = [];

    if (path.isAbsolute(normalized)) {
      candidates.push(normalized);
    } else {
      candidates.push(path.resolve(currentTextureBaseDir || process.cwd(), normalized));

      if (currentTextureBaseStem) {
        candidates.push(path.resolve(
          currentTextureBaseDir || process.cwd(),
          `${currentTextureBaseStem}.fbm`,
          path.basename(normalized)
        ));
        candidates.push(path.resolve(
          currentTextureBaseDir || process.cwd(),
          `${currentTextureBaseStem}.fbm`,
          normalized
        ));
      }
    }

    return (async () => {
      for (const candidatePath of candidates) {
        try {
          const buffer = await fs.readFile(candidatePath);
          const decoded = decodeImageBuffer(buffer);
          if (decoded) {
            return decoded;
          }
        } catch {
          // ignore and keep trying
        }
      }

      return null;
    })();
  }

  return Promise.resolve(null);
}

function isTextureReady(texture) {
  if (!texture) return false;
  const image = texture.image;
  return Boolean(
    image && (
      image._pixelData !== undefined ||
      image.data !== undefined ||
      (Number(image.width) > 0 && Number(image.height) > 0)
    )
  );
}

function writeImageToCanvas(target, targetWidth, sourceData, sourceWidth, sourceHeight, transform) {
  target.fill(0);

  for (let y = 0; y < sourceHeight; y += 1) {
    const dy = transform.flipY ? (sourceHeight - 1 - y) : y;

    for (let x = 0; x < sourceWidth; x += 1) {
      const srcIndex = (y * sourceWidth + x) * 4;
      const dstIndex = (dy * targetWidth + x) * 4;
      target[dstIndex] = sourceData[srcIndex];
      target[dstIndex + 1] = sourceData[srcIndex + 1];
      target[dstIndex + 2] = sourceData[srcIndex + 2];
      target[dstIndex + 3] = sourceData[srcIndex + 3];
    }
  }
}

function installBrowserPolyfills() {
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
  }

  if (typeof globalThis.window.URL === 'undefined') {
    globalThis.window.URL = {};
  }

  globalThis.window.URL.createObjectURL = (blob) => {
    const id = `blob-${blobCounter += 1}`;
    blobRegistry.set(id, blob);
    return `blob:${id}`;
  };

  globalThis.window.URL.revokeObjectURL = (url) => {
    const match = /^blob:(blob-\d+)$/.exec(url);
    if (match) {
      blobRegistry.delete(match[1]);
    }
  };

  if (typeof globalThis.window.innerWidth === 'undefined') {
    globalThis.window.innerWidth = 1;
  }

  if (typeof globalThis.window.innerHeight === 'undefined') {
    globalThis.window.innerHeight = 1;
  }

  if (typeof globalThis.document === 'undefined') {
    if (typeof globalThis.HTMLImageElement === 'undefined') {
      globalThis.HTMLImageElement = class HTMLImageElement {
        constructor() {
          this.width = 0;
          this.height = 0;
          this._pixelData = null;
          this._listeners = new Map();
        }

        addEventListener(eventName, handler) {
          this._listeners.set(eventName, handler);
        }

        removeEventListener(eventName) {
          this._listeners.delete(eventName);
        }

        set src(value) {
          this._src = value;
          queueMicrotask(async () => {
            try {
              let buffer = null;
              if (typeof value === 'string' && value.startsWith('blob:')) {
                const blob = blobRegistry.get(value.slice(5));
                if (blob) {
                  buffer = Buffer.from(await blob.arrayBuffer());
                }
              } else if (typeof value === 'string' && value.startsWith('data:')) {
                const decoded = decodeDataUrl(value);
                buffer = decoded?.buffer || null;
              }

              const decodedImage = buffer ? decodeImageBuffer(buffer) : null;
              this.width = decodedImage?.width || 1;
              this.height = decodedImage?.height || 1;
              this._pixelData = decodedImage?.data || Buffer.from([255, 255, 255, 255]);
              this._listeners.get('load')?.();
            } catch (error) {
              this._listeners.get('error')?.(error);
            }
          });
        }

        get src() {
          return this._src || '';
        }
      };
    }

    if (typeof globalThis.ImageData === 'undefined') {
      globalThis.ImageData = class ImageData {
        constructor(data, width, height) {
          this.data = data;
          this.width = width;
          this.height = height;
        }
      };
    }

    if (typeof globalThis.HTMLCanvasElement === 'undefined') {
      globalThis.HTMLCanvasElement = class HTMLCanvasElement {
        constructor() {
          this._width = 1;
          this._height = 1;
          this._data = Buffer.from([0, 0, 0, 0]);
        }

        _ensureSize() {
          const size = Math.max(1, this._width * this._height * 4);
          if (this._data.length !== size) {
            this._data = Buffer.alloc(size);
          }
        }

        get width() {
          return this._width;
        }

        set width(value) {
          this._width = Math.max(1, value | 0);
          this._ensureSize();
        }

        get height() {
          return this._height;
        }

        set height(value) {
          this._height = Math.max(1, value | 0);
          this._ensureSize();
        }

        getContext() {
          const canvas = this;
          const state = { flipY: false };

          const applyImage = (imageLike) => {
            if (!imageLike) {
              return;
            }

            const rawData = imageLike._pixelData || imageLike.data;
            const sourceData = rawData ? Buffer.from(rawData) : null;
            if (!sourceData) {
              return;
            }

            const sourceWidth = Math.max(1, imageLike.width || 1);
            const sourceHeight = Math.max(1, imageLike.height || 1);
            canvas._ensureSize();
            writeImageToCanvas(canvas._data, canvas._width, sourceData, sourceWidth, sourceHeight, state);
          };

          return {
            canvas,
            fillRect() {},
            clearRect() {},
            drawImage(image) {
              applyImage(image);
            },
            putImageData(imageData) {
              if (!imageData?.data) {
                return;
              }

              canvas._width = imageData.width;
              canvas._height = imageData.height;
              canvas._data = Buffer.alloc(canvas._width * canvas._height * 4);
              applyImage({
                data: imageData.data,
                width: imageData.width,
                height: imageData.height
              });
            },
            getImageData() {
              return { data: new Uint8ClampedArray(canvas._data) };
            },
            createImageData() {
              return { data: new Uint8ClampedArray(canvas._data.length) };
            },
            setTransform() {
              state.flipY = false;
            },
            scale(x, y) {
              if (x === 1 && y === -1) {
                state.flipY = true;
              }
            },
            rotate() {
            },
            translate() {
            },
            save() {},
            restore() {},
            beginPath() {},
            moveTo() {},
            lineTo() {},
            closePath() {},
            stroke() {},
            fill() {},
            measureText() {
              return { width: 0 };
            },
            transform() {},
            rect() {},
            clip() {}
          };
        }

        toBlob(callback, mimeType = 'image/png') {
          const png = new PNG({ width: this._width, height: this._height });
          png.data = Buffer.from(this._data);
          callback(new Blob([PNG.sync.write(png)], { type: mimeType }));
        }

        toDataURL() {
          const png = new PNG({ width: this._width, height: this._height });
          png.data = Buffer.from(this._data);
          return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
        }

        convertToBlob() {
          const png = new PNG({ width: this._width, height: this._height });
          png.data = Buffer.from(this._data);
          return Promise.resolve(new Blob([PNG.sync.write(png)], { type: 'image/png' }));
        }
      };
    }

    globalThis.document = {
      createElement(tagName) {
        if (tagName === 'img') {
          return new globalThis.HTMLImageElement();
        }

        if (tagName !== 'canvas') {
          return {};
        }

        return new globalThis.HTMLCanvasElement();
      },
      createElementNS(_namespaceURI, tagName) {
        return this.createElement(tagName);
      }
    };
  }

  if (typeof globalThis.FileReader === 'undefined') {
    globalThis.FileReader = class FileReader {
      constructor() {
        this.result = null;
        this.onloadend = null;
        this.onerror = null;
      }

      async readAsArrayBuffer(blob) {
        try {
          this.result = await blob.arrayBuffer();
          this.onloadend?.();
        } catch (error) {
          this.onerror?.(error);
        }
      }

      async readAsDataURL(blob) {
        try {
          const buffer = Buffer.from(await blob.arrayBuffer());
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
          this.onloadend?.();
        } catch (error) {
          this.onerror?.(error);
        }
      }
    };
  }
}

async function loadThreeExtras() {
  installBrowserPolyfills();
  THREE.TextureLoader.prototype.load = function loadTexture(url, onLoad, onProgress, onError) {
    const texture = new THREE.Texture();
    const pending = decodeTextureUrl(url)
      .then((image) => {
        const resolvedImage = new globalThis.HTMLImageElement();
        resolvedImage.width = image?.width || 1;
        resolvedImage.height = image?.height || 1;
        resolvedImage._pixelData = image?.data || Buffer.from([255, 255, 255, 255]);
        texture.image = resolvedImage;
        texture.needsUpdate = true;
        onLoad?.(texture);
      })
      .catch((error) => {
        onError?.(error);
      });

    texture.userData.loadPromise = pending;

    return texture;
  };

  const [{ FBXLoader }, { GLTFExporter }] = await Promise.all([
    import('three/examples/jsm/loaders/FBXLoader.js'),
    import('three/examples/jsm/exporters/GLTFExporter.js')
  ]);

  return { FBXLoader, GLTFExporter };
}

function printUsage() {
  console.log('Usage:');
  console.log('  node src/merge-fbx-folder.mjs "C:\\\\path\\\\to\\\\fbx-folder"');
  console.log('  node src/merge-fbx-folder.mjs "C:\\\\path\\\\to\\\\fbx-folder" "C:\\\\path\\\\to\\\\fbx-folder\\\\output.glb"');
  console.log('  node src/merge-fbx-folder.mjs --preview "C:\\\\path\\\\to\\\\fbx-folder"');
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function collectFbxFiles(rootDir) {
  const results = [];
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.fbx') {
        results.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  results.sort((a, b) => collator.compare(a, b));
  return results;
}

function loadFbx(filePath) {
  throw new Error('FBXLoader must be created after browser polyfills are installed.');
}

function loadFbxWithLoader(FBXLoader, filePath) {
  const loader = new FBXLoader();
  const directory = path.dirname(filePath) + path.sep;

  return fs.readFile(filePath).then(async (buffer) => {
    const arrayBuffer = toArrayBuffer(buffer);
    currentTextureBaseDir = directory;
    currentTextureBaseStem = path.basename(filePath, path.extname(filePath));
    let scene;
    try {
      scene = loader.parse(arrayBuffer, directory);
    } finally {
      currentTextureBaseDir = '';
      currentTextureBaseStem = '';
    }

    const textures = [];
    const seenTextures = new Set();

    scene.traverse((object) => {
      if (!object.isMesh && !object.isSkinnedMesh) {
        return;
      }

      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;

        for (const key of Object.keys(material)) {
          const value = material[key];
          if (value && value.isTexture && !seenTextures.has(value)) {
            seenTextures.add(value);
            textures.push(value);
          }
        }
      }
    });

    await Promise.all(
      textures
        .map((texture) => texture?.userData?.loadPromise)
        .filter(Boolean)
    );

    for (const texture of textures) {
      if (!texture.image && texture.source?.data !== undefined) {
        texture.image = texture.source.data;
      }
    }

    return scene;
  });
}

function getTrackRange(track) {
  const { times } = track;
  if (!times || times.length === 0) {
    return null;
  }

  let min = times[0];
  let max = times[0];

  for (let i = 1; i < times.length; i += 1) {
    const value = times[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }

  return { min, max };
}

function clipDuration(clip) {
  if (!clip || !clip.tracks || clip.tracks.length === 0) {
    return 0;
  }

  let clipStart = Number.POSITIVE_INFINITY;
  let clipEnd = Number.NEGATIVE_INFINITY;

  for (const track of clip.tracks) {
    const range = getTrackRange(track);
    if (!range) continue;
    if (range.min < clipStart) clipStart = range.min;
    if (range.max > clipEnd) clipEnd = range.max;
  }

  if (!Number.isFinite(clipStart) || !Number.isFinite(clipEnd)) {
    return 0;
  }

  return Math.max(0, clipEnd - clipStart);
}

function buildExportClips(loaded) {
  const exportClips = [];

  for (const { filePath, object } of loaded) {
    const fileBase = path.basename(filePath, path.extname(filePath));
    const clips = Array.isArray(object.animations) ? object.animations : [];

    for (let index = 0; index < clips.length; index += 1) {
      const sourceClip = clips[index];
      if (!sourceClip || !sourceClip.tracks || sourceClip.tracks.length === 0) {
        continue;
      }

      const namedClip = sourceClip.clone();
      namedClip.name = clips.length === 1 ? fileBase : `${fileBase}_${index + 1}`;
      exportClips.push(namedClip);
    }
  }

  return exportClips;
}

function sanitizeForExport(scene) {
  scene.traverse((object) => {
    if (!object.isMesh || !object.material) {
      return;
    }

    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const convertedMaterials = [];
    for (const material of materials) {
      if (!material) continue;

      const standard = new THREE.MeshStandardMaterial({
        name: material.name,
        color: new THREE.Color(0xffffff),
        map: material.map || null,
        normalMap: material.normalMap || null,
        alphaMap: material.alphaMap || null,
        emissiveMap: material.emissiveMap || null,
        metalnessMap: material.metalnessMap || null,
        roughnessMap: material.roughnessMap || null,
        transparent: false,
        opacity: 1,
        alphaTest: 0,
        side: THREE.DoubleSide,
        metalness: 0,
        roughness: 1
      });

      standard.map && (standard.map.colorSpace = THREE.SRGBColorSpace);
      standard.normalMap && (standard.normalMap.colorSpace = THREE.NoColorSpace);
      standard.alphaMap && (standard.alphaMap.colorSpace = THREE.NoColorSpace);
      standard.emissiveMap && (standard.emissiveMap.colorSpace = THREE.SRGBColorSpace);
      standard.metalnessMap && (standard.metalnessMap.colorSpace = THREE.NoColorSpace);
      standard.roughnessMap && (standard.roughnessMap.colorSpace = THREE.NoColorSpace);
      standard.needsUpdate = true;

      material.dispose?.();
      convertedMaterials.push(standard);
    }

    object.material = Array.isArray(object.material) ? convertedMaterials : convertedMaterials[0];
  });

  return scene;
}

async function loadExportConfig() {
  const configPath = process.env.FBX_GLB_CONFIG_PATH;
  if (!configPath) {
    return {};
  }

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function applyRootAdjustments(scene, settings) {
  if (!scene || !settings) {
    return;
  }

  const location = settings.rootLocation;
  if (Array.isArray(location) && location.length === 3) {
    scene.position.set(Number(location[0]) || 0, Number(location[1]) || 0, Number(location[2]) || 0);
  }

  const rotationDegrees = settings.rootRotationDegrees;
  if (Array.isArray(rotationDegrees) && rotationDegrees.length === 3) {
    scene.rotation.order = 'XYZ';
    scene.rotation.set(
      THREE.MathUtils.degToRad(Number(rotationDegrees[0]) || 0),
      THREE.MathUtils.degToRad(Number(rotationDegrees[1]) || 0),
      THREE.MathUtils.degToRad(Number(rotationDegrees[2]) || 0)
    );
  }
}

async function exportGlb(GLTFExporter, scene, animations, outputPath) {
  const exporter = new GLTFExporter();

  const result = await new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      resolve,
      reject,
      {
        binary: true,
        animations,
        trs: false,
        onlyVisible: false,
        forceIndices: true
      }
    );
  });

  await fs.writeFile(outputPath, Buffer.from(result));
}

async function runDirectMerge(inputDir, outputPath, { preview = false } = {}) {
  const { FBXLoader, GLTFExporter } = await loadThreeExtras();
  const fbxFiles = await collectFbxFiles(inputDir);
  if (!fbxFiles.length) {
    throw new Error(`No FBX files found in: ${inputDir}`);
  }

  const loaded = [];
  for (const filePath of fbxFiles) {
    process.stdout.write(`Loading ${path.basename(filePath)}...\n`);
    const object = await loadFbxWithLoader(FBXLoader, filePath);
    loaded.push({ filePath, object });
  }

  const baseScene = sanitizeForExport(loaded[0].object);
  const exportClips = buildExportClips(loaded);
  const exportConfig = await loadExportConfig();
  applyRootAdjustments(baseScene, exportConfig.settings || {});

  baseScene.updateMatrixWorld(true);
  if (preview) {
    process.stdout.write('Preview mode now uses the direct Three.js export path.\n');
  }

  await exportGlb(GLTFExporter, baseScene, exportClips, outputPath || path.join(inputDir, 'merged.glb'));
}

async function main() {
  const preview = process.argv[2] === '--preview';
  const inputDir = preview ? process.argv[3] : process.argv[2];
  const outputPath = preview ? null : (process.argv[3] || (inputDir ? path.join(inputDir, 'merged.glb') : null));

  if (!inputDir) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const inputStat = await fs.stat(inputDir).catch(() => null);
  if (!inputStat || !inputStat.isDirectory()) {
    throw new Error(`The folder does not exist or is not a directory: ${inputDir}`);
  }

  await runDirectMerge(inputDir, outputPath, { preview });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
