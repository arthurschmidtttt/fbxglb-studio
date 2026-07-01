import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const els = {
  inputDir: document.getElementById('inputDir'),
  pickDirBtn: document.getElementById('pickDirBtn'),
  showRigChk: document.getElementById('showRigChk'),
  showMeshChk: document.getElementById('showMeshChk'),
  frameBtn: document.getElementById('frameBtn'),
  exportBtn: document.getElementById('exportBtn'),
  reviewPanel: document.getElementById('reviewPanel'),
  reviewActions: document.getElementById('reviewActions'),
  backBtn: document.getElementById('backBtn'),
  saveFinalBtn: document.getElementById('saveFinalBtn'),
  materialSelect: document.getElementById('materialSelect'),
  textureSelect: document.getElementById('textureSelect'),
  tintColor: document.getElementById('tintColor'),
  tintHex: document.getElementById('tintHex'),
  opacityRange: document.getElementById('opacityRange'),
  opacityOut: document.getElementById('opacityOut'),
  applyAllMaterials: document.getElementById('applyAllMaterials'),
  copyTextureBtn: document.getElementById('copyTextureBtn'),
  resetMaterialBtn: document.getElementById('resetMaterialBtn'),
  toastArea: document.getElementById('toastArea'),
  clipList: document.getElementById('clipList'),
  animList: document.getElementById('animList'),
  loadingOverlay: document.getElementById('loadingOverlay'),
  preview: document.getElementById('preview'),
  rotX: document.getElementById('rotX'),
  rotY: document.getElementById('rotY'),
  rotZ: document.getElementById('rotZ'),
  posX: document.getElementById('posX'),
  posY: document.getElementById('posY'),
  posZ: document.getElementById('posZ'),
  rotXOut: document.getElementById('rotXOut'),
  rotYOut: document.getElementById('rotYOut'),
  rotZOut: document.getElementById('rotZOut'),
  posXOut: document.getElementById('posXOut'),
  posYOut: document.getElementById('posYOut'),
  posZOut: document.getElementById('posZOut')
};

const state = {
  dir: '',
  projectRoot: '',
  files: [],
  fileMap: new Map(),
  fileByName: new Map(),
  selectedFile: '',
  model: null,
  boxHelper: null,
  skeletonHelper: null,
  rigOnly: true,
  mixer: null,
  clock: new THREE.Clock(),
  activeAction: null,
  mode: 'fbx',
  animations: [],
  animationEntries: [],
  currentAnimationIndex: -1,
  reviewMaterials: [],
  reviewMaterialSnapshot: new Map(),
  reviewTempPath: ''
};

const fallbackTextureUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5f8AAAAASUVORK5CYII=';

function setStatus(text) {
  console.debug(text);
}

function showToast(message, kind = 'info', ttl = 4200) {
  if (!els.toastArea) return;
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  els.toastArea.appendChild(toast);
  window.setTimeout(() => {
    toast.remove();
  }, ttl);
}

function setLoading(isLoading) {
  els.loadingOverlay.classList.toggle('hidden', !isLoading);
  els.pickDirBtn.disabled = isLoading;
  els.exportBtn.disabled = isLoading;
  els.backBtn.disabled = isLoading;
  els.saveFinalBtn.disabled = isLoading;
  els.copyTextureBtn.disabled = isLoading;
  els.resetMaterialBtn.disabled = isLoading;
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message);
  showToast(message, 'error', 6000);
  console.error(error);
}

function setMode(mode) {
  state.mode = mode;
  const reviewMode = mode === 'review';
  els.reviewPanel.classList.toggle('hidden', !reviewMode);
  els.reviewActions.classList.toggle('hidden', !reviewMode);
  els.exportBtn.textContent = reviewMode ? 'Save final' : 'Generate GLB preview';
  els.showRigChk.checked = reviewMode ? false : true;
  els.showMeshChk.checked = true;
  els.clipList.disabled = reviewMode;
  applyVisibilityFromControls();
}

function clearCurrentModel() {
  if (!state.model) {
    return;
  }

  if (state.skeletonHelper) {
    scene.remove(state.skeletonHelper);
    state.skeletonHelper = null;
  }

  if (state.boxHelper) {
    scene.remove(state.boxHelper);
    state.boxHelper = null;
  }

  scene.remove(state.model);
  state.model.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose?.();
    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        mat.map?.dispose?.();
        mat.normalMap?.dispose?.();
        mat.alphaMap?.dispose?.();
        mat.emissiveMap?.dispose?.();
        mat.dispose?.();
      }
    }
  });

  state.model = null;
  state.mixer = null;
  state.animations = [];
  state.animationEntries = [];
  state.currentAnimationIndex = -1;
  state.activeAction = null;
}

function collectMaterialsFromScene(root) {
  const materials = [];
  const seen = new Set();

  root.traverse((object) => {
    if (!object.isMesh || !object.material) {
      return;
    }

    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (!material || seen.has(material)) {
        continue;
      }
      seen.add(material);
      materials.push(material);
    }
  });

  return materials;
}

function materialLabel(material, index) {
  return material?.name || material?.userData?.originalName || `Material ${index + 1}`;
}

function refreshReviewPanel() {
  if (!state.model) {
    return;
  }

  state.reviewMaterials = collectMaterialsFromScene(state.model);
  els.materialSelect.innerHTML = '';
  els.textureSelect.innerHTML = '';

  state.reviewMaterials.forEach((material, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = materialLabel(material, index);
    els.materialSelect.appendChild(option);
  });

  state.reviewMaterials.forEach((material, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${materialLabel(material, index)} texture`;
    els.textureSelect.appendChild(option);
  });

  els.materialSelect.selectedIndex = 0;
  els.textureSelect.selectedIndex = 0;
  state.reviewMaterialSnapshot.clear();
  for (const material of state.reviewMaterials) {
    state.reviewMaterialSnapshot.set(material, {
      color: material.color?.clone?.() || new THREE.Color(0xffffff),
      opacity: material.opacity ?? 1,
      transparent: Boolean(material.transparent),
      map: material.map || null,
      normalMap: material.normalMap || null,
      alphaMap: material.alphaMap || null
    });
  }

  syncReviewMaterialFields();
}

function getSelectedReviewMaterials() {
  if (!state.reviewMaterials.length) {
    return [];
  }

  const selectedIndex = Number(els.materialSelect.value || 0);
  const selected = state.reviewMaterials[selectedIndex];
  if (!selected) {
    return [];
  }

  if (els.applyAllMaterials.checked) {
    return state.reviewMaterials.slice();
  }

  return [selected];
}

function syncReviewMaterialFields() {
  const material = state.reviewMaterials[Number(els.materialSelect.value || 0)];
  if (!material) {
    return;
  }

  const color = `#${material.color?.getHexString?.() || 'ffffff'}`;
  els.tintColor.value = color;
  els.tintHex.value = color;
  const opacity = Math.round(((material.opacity ?? 1) * 100));
  els.opacityRange.value = String(opacity);
  els.opacityOut.value = String(opacity);
}

function applyReviewMaterialSettings() {
  const materials = getSelectedReviewMaterials();
  if (!materials.length) {
    return;
  }

  const color = new THREE.Color(els.tintHex.value || els.tintColor.value || '#ffffff');
  const opacity = Math.min(100, Math.max(0, Number(els.opacityOut.value || els.opacityRange.value || 100))) / 100;

  for (const material of materials) {
    if (material.color) {
      material.color.copy(color);
    }
    material.opacity = opacity;
    material.transparent = opacity < 1;
    material.alphaTest = opacity < 1 ? 0.001 : 0;
    material.needsUpdate = true;
  }
}

function copyTextureFromSelectedMaterial() {
  if (!state.reviewMaterials.length) {
    return;
  }

  const source = state.reviewMaterials[Number(els.textureSelect.value || 0)];
  if (!source) {
    return;
  }

  for (const material of getSelectedReviewMaterials()) {
    if (!material || material === source) continue;
    material.map = source.map || null;
    material.normalMap = source.normalMap || null;
    material.alphaMap = source.alphaMap || null;
    material.emissiveMap = source.emissiveMap || null;
    material.color?.set?.(0xffffff);
    material.transparent = false;
    material.opacity = 1;
    material.alphaTest = 0;
    material.map && (material.map.colorSpace = THREE.SRGBColorSpace);
    material.normalMap && (material.normalMap.colorSpace = THREE.NoColorSpace);
    material.alphaMap && (material.alphaMap.colorSpace = THREE.NoColorSpace);
    material.emissiveMap && (material.emissiveMap.colorSpace = THREE.SRGBColorSpace);
    material.needsUpdate = true;
  }
}

function createAnimationEntries(clips, previousEntries = []) {
  const previousByKey = new Map(
    previousEntries.map((entry) => [
      `${entry.clip?.name || ''}::${entry.clip?.duration || 0}::${entry.clip?.tracks?.length || 0}`,
      entry
    ])
  );

  return (clips || []).map((clip, index) => {
    const key = `${clip?.name || ''}::${clip?.duration || 0}::${clip?.tracks?.length || 0}`;
    const previous = previousByKey.get(key);
    const clipName = clip?.name || `Animation ${index + 1}`;
    return {
      clip,
      include: previous ? previous.include !== false : true,
      exportName: previous ? previous.exportName : clipName,
      originalName: clipName
    };
  });
}

function refreshAnimationPanel() {
  els.animList.innerHTML = '';

  state.animationEntries.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'anim-item';
    row.dataset.index = String(index);
    if (index === state.currentAnimationIndex) {
      row.classList.add('active');
    }

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = entry.include !== false;
    check.dataset.action = 'toggle-animation';

    const name = document.createElement('input');
    name.type = 'text';
    name.value = entry.exportName || entry.originalName || entry.clip?.name || '';
    name.spellcheck = false;
    name.dataset.action = 'rename-animation';

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'ghost anim-play';
    play.textContent = '▶';
    play.title = 'Preview';
    play.dataset.action = 'play-animation';

    row.appendChild(check);
    row.appendChild(name);
    row.appendChild(play);
    els.animList.appendChild(row);
  });
}

function updateAnimationEntryFromRow(row) {
  const index = Number(row?.dataset?.index);
  const entry = state.animationEntries[index];
  if (!entry) {
    return;
  }

  const check = row.querySelector('input[data-action="toggle-animation"]');
  const name = row.querySelector('input[data-action="rename-animation"]');
  entry.include = Boolean(check?.checked);
  const exportName = name?.value?.trim() || entry.originalName || entry.clip?.name || `Animation ${index + 1}`;
  entry.exportName = exportName;
  if (entry.clip) {
    entry.clip.name = exportName;
  }
}

function getSelectedAnimationClips() {
  return state.animationEntries
    .filter((entry) => entry.include !== false && entry.clip)
    .map((entry) => {
      const clip = entry.clip.clone();
      clip.name = (entry.exportName || entry.clip.name || '').trim() || entry.originalName || entry.clip.name || 'Animation';
      return clip;
    });
}

function playAnimationIndex(index) {
  if (!state.model || !state.mixer) {
    return;
  }

  const entry = state.animationEntries[index];
  if (!entry?.clip) {
    return;
  }

  state.activeAction?.stop();
  state.activeAction = state.mixer.clipAction(entry.clip);
  state.activeAction.reset().play();
  state.mixer.setTime(0);
  state.mixer.update(0);
  state.currentAnimationIndex = index;
  refreshAnimationPanel();
}

function isTextureReady(texture) {
  if (!texture) return false;
  const image = texture.image;
  return Boolean(
    image && (
      image.data !== undefined ||
      (Number(image.width) > 0 && Number(image.height) > 0)
    )
  );
}

function resetSelectedReviewMaterials() {
  for (const material of getSelectedReviewMaterials()) {
    const snapshot = state.reviewMaterialSnapshot.get(material);
    if (!snapshot) continue;
    material.color?.copy?.(snapshot.color);
    material.opacity = snapshot.opacity;
    material.transparent = snapshot.transparent;
    material.map = snapshot.map;
    material.normalMap = snapshot.normalMap;
    material.alphaMap = snapshot.alphaMap;
    material.needsUpdate = true;
  }
  syncReviewMaterialFields();
}

function pathDirname(filePath) {
  const normalized = filePath.replace(/\//g, '\\');
  const idx = normalized.lastIndexOf('\\');
  return idx >= 0 ? normalized.slice(0, idx) : '';
}

function pathBasename(filePath) {
  const normalized = filePath.replace(/\//g, '\\');
  const idx = normalized.lastIndexOf('\\');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function pathJoin(...parts) {
  const joined = parts
    .filter(Boolean)
    .join('\\')
    .replace(/\\+/g, '\\')
    .replace(/\/+/g, '\\');
  return joined;
}

function openFolderPicker() {
  return fetch('/api/pick-folder').then(async (response) => {
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { error: raw };
    }

    if (!response.ok) {
      throw new Error(data.error || `Failed to pick folder (${response.status}).`);
    }

    return data.path || '';
  });
}

function normalizeRelativePath(value) {
  return value.replace(/\//g, '\\').replace(/^\.\\/, '').toLowerCase();
}

function normalizeFileName(value) {
  return value.replace(/\//g, '\\').split('\\').pop().toLowerCase();
}

function stripProjectPrefix(value) {
  if (!state.projectRoot) {
    return value;
  }

  const prefix = state.projectRoot.toLowerCase();
  const lower = value.toLowerCase();
  if (lower.startsWith(prefix)) {
    return value.slice(state.projectRoot.length);
  }

  return value;
}

function stripExtension(filePath) {
  return filePath.replace(/\.[^.\\\/]+$/, '');
}

function resolveTextureCandidate(baseFilePath, relativeUrl) {
  const resolved = resolveRelativePath(baseFilePath, relativeUrl);
  const normalizedResolved = normalizeRelativePath(resolved);
  const direct = state.fileMap.get(normalizedResolved);
  if (direct) {
    return { file: direct, label: resolved };
  }

  const baseDir = pathDirname(baseFilePath);
  const baseStem = stripExtension(pathBasename(baseFilePath));
  const filename = normalizeFileName(relativeUrl);
  const filenameCandidates = [filename, normalizeFileName(stripProjectPrefix(pathBasename(relativeUrl)))];

  for (const candidateName of filenameCandidates) {
    const basenameMatch = state.fileByName.get(candidateName);
    if (basenameMatch) {
      return { file: basenameMatch, label: basenameMatch };
    }
  }

  const requestedSuffix = normalizeFileName(stripProjectPrefix(pathBasename(relativeUrl)));
  for (const file of state.fileByName.values()) {
    const fileName = pathBasename(file).toLowerCase();
    if (requestedSuffix.endsWith(fileName) || fileName.endsWith(requestedSuffix)) {
      return { file, label: file };
    }
  }

  const suffixName = stripProjectPrefix(pathBasename(relativeUrl));
  const fbmCandidates = [
    pathJoin(baseDir, `${baseStem}.fbm`, pathBasename(relativeUrl)),
    pathJoin(baseDir, `${baseStem}.fbm`, suffixName),
    pathJoin(baseDir, `${state.projectRoot}.fbm`, pathBasename(relativeUrl)),
    pathJoin(baseDir, `${state.projectRoot}.fbm`, suffixName)
  ];

  for (const candidatePath of fbmCandidates) {
    const fbmMatch = state.fileMap.get(normalizeRelativePath(candidatePath));
    if (fbmMatch) {
      return { file: fbmMatch, label: candidatePath };
    }
  }

  for (const candidateName of filenameCandidates) {
    const stemMatch = state.fileByName.get(candidateName);
    if (stemMatch) {
      return { file: stemMatch, label: stemMatch };
    }
  }

  return null;
}

function resolveRelativePath(baseFilePath, relativeUrl) {
  if (!relativeUrl || /^([a-z]+:|blob:|data:)/i.test(relativeUrl)) {
    return relativeUrl;
  }

  const clean = relativeUrl.split('?')[0].split('#')[0].replace(/\//g, '\\');
  if (/^[A-Za-z]:\\/.test(clean) || /^\\\\/.test(clean)) {
    return clean;
  }

  const baseDir = pathDirname(baseFilePath);
  const stack = baseDir.split('\\').filter(Boolean);

  for (const segment of clean.split('\\')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }

  if (/^[A-Za-z]:$/.test(stack[0])) {
    return `${stack[0]}\\${stack.slice(1).join('\\')}`;
  }

  return stack.join('\\');
}

function updateNumericOutputs() {
  els.rotXOut.value = els.rotX.value;
  els.rotYOut.value = els.rotY.value;
  els.rotZOut.value = els.rotZ.value;
  els.posXOut.value = els.posX.value;
  els.posYOut.value = els.posY.value;
  els.posZOut.value = els.posZ.value;
}

function previewTransform() {
  if (!state.model) return;

  state.model.rotation.set(
    THREE.MathUtils.degToRad(Number(els.rotX.value)),
    THREE.MathUtils.degToRad(Number(els.rotY.value)),
    THREE.MathUtils.degToRad(Number(els.rotZ.value))
  );

  state.model.position.set(
    Number(els.posX.value) / 100,
    Number(els.posY.value) / 100,
    Number(els.posZ.value) / 100
  );

  updateNumericOutputs();
}

function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    return;
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  const fitHeightDistance = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));
  const fitWidthDistance = fitHeightDistance / camera.aspect;
  const distance = Math.max(fitHeightDistance, fitWidthDistance);

  controls.target.copy(center);
  camera.position.set(center.x + distance * 1.1, center.y + distance * 0.7, center.z + distance * 1.7);
  controls.minDistance = distance * 0.15;
  controls.maxDistance = distance * 10;
  controls.enableDamping = true;
  camera.lookAt(center);
  camera.near = Math.max(distance / 100, 0.001);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function applyRigVisibility(rigOnly) {
  state.rigOnly = rigOnly;
  if (!state.model) return;

  state.model.traverse((obj) => {
    if (obj.isMesh) {
      obj.visible = !rigOnly;
    }
  });
}

function applyVisibilityFromControls() {
  const showRig = Boolean(els.showRigChk?.checked);
  const showMesh = Boolean(els.showMeshChk?.checked);
  state.rigOnly = showRig && !showMesh;

  if (!state.model) {
    return;
  }

  state.model.traverse((obj) => {
    if (obj.isMesh) {
      obj.visible = showMesh;
    }
  });

  if (state.skeletonHelper) {
    state.skeletonHelper.visible = showRig;
  }
}

function autoFrameCurrentModel() {
  const target = state.skeletonHelper?.visible ? state.skeletonHelper : state.model;
  if (!target) {
    return;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      frameObject(target);
    });
  });
}

function createRenderer() {
  const renderer = new THREE.WebGLRenderer({
    canvas: els.preview,
    antialias: true,
    alpha: false
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  return renderer;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111317);

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(2.8, 2.0, 3.8);

const renderer = createRenderer();
const controls = new OrbitControls(camera, els.preview);
controls.target.set(0, 1.2, 0);
controls.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 2.4));
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
keyLight.position.set(4, 8, 6);
scene.add(keyLight);
scene.add(new THREE.AxesHelper(0.5));

const grid = new THREE.GridHelper(10, 20, 0xffb703, 0x404756);
grid.position.y = 0;
scene.add(grid);

function resize() {
  const rect = els.preview.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / Math.max(rect.height, 1);
  camera.updateProjectionMatrix();
}

window.addEventListener('resize', resize);

async function loadFbx(filePath) {
  if (!filePath) return;

  setLoading(true);
  setMode('fbx');
  clearCurrentModel();

  setStatus(`Loading ${pathBasename(filePath)}...`);
  try {
    const sourcePath = state.fileMap.get(normalizeRelativePath(filePath));
    if (!sourcePath) {
      throw new Error(`File not found in selection: ${filePath}`);
    }

    const sourceResponse = await fetch(`/api/file?path=${encodeURIComponent(sourcePath)}`);
    if (!sourceResponse.ok) {
      throw new Error(`Unable to open the FBX (${sourceResponse.status}).`);
    }

    const arrayBuffer = await sourceResponse.arrayBuffer();
    const manager = new THREE.LoadingManager();
    const loadingDone = new Promise((resolve) => {
      manager.onLoad = () => resolve();
      manager.onError = () => {};
    });
    manager.setURLModifier((url) => {
      const candidate = resolveTextureCandidate(filePath, url);
      if (!candidate) {
        return fallbackTextureUrl;
      }

      return `/api/file?path=${encodeURIComponent(candidate.file)}`;
    });
    const loader = new FBXLoader(manager);

    const model = loader.parse(arrayBuffer, pathDirname(filePath));
    const modelBox = new THREE.Box3().setFromObject(model);
    if (!modelBox.isEmpty()) {
      const size = modelBox.getSize(new THREE.Vector3());
      const center = modelBox.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.001);
      const fitTarget = 2.4;
      const fitScale = fitTarget / maxDim;
      model.position.sub(center);
      model.scale.setScalar(fitScale);
    }
    let hasBones = false;
    model.traverse((obj) => {
      if (!obj.isMesh || !obj.material) {
        if (obj.isBone) hasBones = true;
        return;
      }

      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        mat.transparent = false;
        mat.opacity = 1;
        mat.alphaTest = 0;
        mat.depthWrite = true;
        mat.side = THREE.DoubleSide;
        mat.color?.set?.(0xffffff);
        mat.needsUpdate = true;
      }

      if (obj.isSkinnedMesh) {
        hasBones = true;
      }
    });
    state.model = model;
    scene.add(model);
    if (state.boxHelper) {
      scene.remove(state.boxHelper);
    }
    state.boxHelper = new THREE.BoxHelper(model, 0xffb703);
    scene.add(state.boxHelper);
    if (hasBones) {
      state.skeletonHelper = new THREE.SkeletonHelper(model);
      state.skeletonHelper.material.linewidth = 2;
      state.skeletonHelper.material.color.set(0x4dd0ff);
      scene.add(state.skeletonHelper);
    }
    applyVisibilityFromControls();
    autoFrameCurrentModel();

    state.mixer = model.animations?.length ? new THREE.AnimationMixer(model) : null;
    state.animations = Array.isArray(model.animations) ? model.animations : [];
    model.animations = state.animations;
    state.animationEntries = createAnimationEntries(state.animations);
    state.currentAnimationIndex = -1;
    refreshAnimationPanel();
    if (state.animationEntries.length) {
      playAnimationIndex(0);
    }
    previewTransform();
    await loadingDone;
    state.selectedFile = filePath;
    setStatus(`Loaded: ${pathBasename(filePath)}`);
  } finally {
    setLoading(false);
  }
}

async function loadGlbReview(glbPath) {
  setLoading(true);
  setMode('review');
  clearCurrentModel();
  state.reviewTempPath = glbPath;

  try {
    const sourceResponse = await fetch(`/api/file?path=${encodeURIComponent(glbPath)}`);
    if (!sourceResponse.ok) {
      throw new Error(`Unable to open the GLB (${sourceResponse.status}).`);
    }

    const arrayBuffer = await sourceResponse.arrayBuffer();
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(arrayBuffer, '', resolve, reject);
    });
    const model = gltf.scene;
    const textures = [];
    const seenTextures = new Set();
    model.traverse((object) => {
      if (!object.isMesh || !object.material) {
        return;
      }

      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        for (const key of ['map', 'normalMap', 'alphaMap', 'emissiveMap', 'roughnessMap', 'metalnessMap']) {
          const texture = material[key];
          if (texture && !seenTextures.has(texture)) {
            seenTextures.add(texture);
            textures.push(texture);
          }
        }
      }
    });

    const waitStart = Date.now();
    while (Date.now() - waitStart < 5000) {
      if (textures.every((texture) => isTextureReady(texture) || texture.source?.data !== undefined)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    state.model = model;
    state.animations = Array.isArray(gltf.animations) ? gltf.animations : [];
    state.mixer = state.animations.length ? new THREE.AnimationMixer(model) : null;
    state.activeAction = null;
    model.animations = state.animations;
    state.animationEntries = createAnimationEntries(state.animations);
    state.currentAnimationIndex = -1;

    model.traverse((object) => {
      if (!object.isMesh || !object.material) {
        return;
      }

      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        material?.color?.set?.(0xffffff);
        material && (material.transparent = false);
        material && (material.opacity = 1);
        material && (material.alphaTest = 0);
        if (material) {
          material.needsUpdate = true;
        }
      }
    });

    state.boxHelper = new THREE.BoxHelper(model, 0xffb703);
    scene.add(model);
    scene.add(state.boxHelper);

    let hasBones = false;
    model.traverse((obj) => {
      if (obj.isMesh && obj.isSkinnedMesh) {
        hasBones = true;
      }
      if (obj.isBone) {
        hasBones = true;
      }
    });

    if (hasBones) {
      state.skeletonHelper = new THREE.SkeletonHelper(model);
      state.skeletonHelper.material.linewidth = 2;
      state.skeletonHelper.material.color.set(0x4dd0ff);
      scene.add(state.skeletonHelper);
    }

    if (state.animations.length) {
      refreshAnimationPanel();
      playAnimationIndex(0);
    } else {
      refreshAnimationPanel();
    }

    refreshReviewPanel();
    applyVisibilityFromControls();
    autoFrameCurrentModel();
    setStatus(`GLB review loaded: ${pathBasename(glbPath)}`);
  } finally {
    setLoading(false);
  }
}

function exportSceneToBlob(scene, animations) {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        resolve(new Blob([result], { type: 'model/gltf-binary' }));
      },
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
}

async function generateReviewGlb() {
  const exportDir = els.inputDir.value.trim() || state.dir.trim();
  if (!exportDir) {
    showToast('Enter the absolute path of the folder to export.', 'error');
    return;
  }

  const tempPath = pathJoin(exportDir, '.fg-studio-review.glb');
  const payload = {
    inputDir: exportDir,
    outputPath: tempPath,
    settings: {
      rootRotationDegrees: [
        Number(els.rotX.value),
        Number(els.rotY.value),
        Number(els.rotZ.value)
      ],
      rootLocation: [
        Number(els.posX.value) / 100,
        Number(els.posY.value) / 100,
        Number(els.posZ.value) / 100
      ]
    }
  };

  setLoading(true);
  setStatus('Generating GLB preview...');
  showToast('Generating GLB preview...', 'info', 2600);
  try {
    const response = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { error: raw };
    }

    if (!response.ok) {
      throw new Error(data.error || `Export failed (${response.status}).`);
    }

    const reviewPath = data.outputPath || tempPath;
    await loadGlbReview(reviewPath);
    showToast('GLB preview loaded. Adjust and save the final file.', 'success', 5000);
  } catch (error) {
    showError(error);
  } finally {
    setLoading(false);
  }
}

async function saveFinalGlb() {
  if (!state.model) {
    showToast('No GLB is loaded to save.', 'error');
    return;
  }

  if (typeof window.showSaveFilePicker !== 'function') {
    showToast('This browser does not support the native save picker.', 'error');
    return;
  }

  let outputHandle;
  try {
    outputHandle = await window.showSaveFilePicker({
      suggestedName: 'merged.glb',
      types: [
        {
          description: 'GLB',
          accept: { 'model/gltf-binary': ['.glb'] }
        }
      ]
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return;
    }
    showError(error);
    return;
  }

  setLoading(true);
  setStatus('Saving final GLB...');
  showToast('Saving final GLB...', 'info', 2600);
  try {
    const blob = await exportSceneToBlob(state.model, getSelectedAnimationClips());
    const writable = await outputHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    showToast(`File saved: ${outputHandle.name || 'merged.glb'}`, 'success', 6500);
  } catch (error) {
    showError(error);
  } finally {
    setLoading(false);
  }
}

function render() {
  requestAnimationFrame(render);
  const delta = state.clock.getDelta();
  state.mixer?.update(delta);
  state.boxHelper?.update?.();
  state.skeletonHelper?.update?.();
  controls.update();
  renderer.render(scene, camera);
}

async function scanDir(dirPath) {
  const targetDir = (dirPath || els.inputDir.value || '').trim();
  if (!targetDir) {
    const message = 'Choose a folder containing FBX files.';
    setStatus(message);
    showToast(message, 'error');
    return;
  }

  setLoading(true);
  try {
    const response = await fetch(`/api/scan?dir=${encodeURIComponent(targetDir)}`);
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { error: raw };
    }

    if (!response.ok) {
      throw new Error(data.error || `Failed to list files (${response.status}).`);
    }

    const files = Array.isArray(data.files) ? data.files : [];
    const selectedFiles = files.filter((file) => file.toLowerCase().endsWith('.fbx'));
    if (!selectedFiles.length) {
      const message = 'No FBX files were found in the selected folder.';
      setStatus(message);
      showToast(message, 'error');
      return;
    }

    state.fileMap.clear();
    state.fileByName.clear();
    state.files = selectedFiles;
    state.dir = targetDir;
    state.projectRoot = targetDir;

    for (const file of files) {
      const rel = normalizeRelativePath(file);
      state.fileMap.set(rel, file);
      state.fileByName.set(pathBasename(file).toLowerCase(), file);
    }

    els.clipList.innerHTML = '';
    for (const file of selectedFiles) {
      const option = document.createElement('option');
      option.value = file;
      option.textContent = file.startsWith(targetDir)
        ? file.slice(targetDir.length).replace(/^\\+/, '').replace(/^\/+/, '')
        : pathBasename(file);
      els.clipList.appendChild(option);
    }

    els.clipList.selectedIndex = 0;
    els.inputDir.value = targetDir;
    await loadFbx(selectedFiles[0]);
    const message = `Folder loaded: ${selectedFiles.length} FBX files found.`;
    setStatus(message);
    showToast(message, 'success');
  } finally {
    setLoading(false);
  }
}

els.pickDirBtn.addEventListener('click', () => {
  setStatus('Opening folder picker...');
  openFolderPicker().then((pickedPath) => {
    if (!pickedPath) {
      return;
    }

    els.inputDir.value = pickedPath;
    state.dir = pickedPath;
    state.projectRoot = pickedPath;
    scanDir(pickedPath).catch(showError);
  }).catch(showError);
});

els.showRigChk.addEventListener('change', applyVisibilityFromControls);
els.showMeshChk.addEventListener('change', applyVisibilityFromControls);

els.frameBtn.addEventListener('click', () => {
  if (state.model) {
    autoFrameCurrentModel();
  }
});

els.clipList.addEventListener('change', () => {
  const selected = els.clipList.value;
  if (state.mode === 'review') {
    showToast('Use Back to FBX to switch files.', 'info', 2600);
    return;
  }
  if (selected) {
    loadFbx(selected).then(() => autoFrameCurrentModel()).catch(showError);
  }
});

els.animList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action="play-animation"]');
  if (!button) {
    return;
  }

  const row = button.closest('.anim-item');
  if (!row) {
    return;
  }

  playAnimationIndex(Number(row.dataset.index));
});

els.animList.addEventListener('change', (event) => {
  const row = event.target.closest('.anim-item');
  if (!row) {
    return;
  }

  updateAnimationEntryFromRow(row);
  refreshAnimationPanel();
});

els.animList.addEventListener('input', (event) => {
  const row = event.target.closest('.anim-item');
  if (!row) {
    return;
  }

  updateAnimationEntryFromRow(row);
});

const rigPairs = [
  [els.rotX, els.rotXOut],
  [els.rotY, els.rotYOut],
  [els.rotZ, els.rotZOut],
  [els.posX, els.posXOut],
  [els.posY, els.posYOut],
  [els.posZ, els.posZOut]
];

for (const [slider, numeric] of rigPairs) {
  slider.addEventListener('input', () => {
    numeric.value = slider.value;
    previewTransform();
  });

  numeric.addEventListener('input', () => {
    slider.value = numeric.value;
    previewTransform();
  });
}

els.materialSelect.addEventListener('change', syncReviewMaterialFields);
els.textureSelect.addEventListener('change', () => {
  copyTextureFromSelectedMaterial();
  applyReviewMaterialSettings();
  syncReviewMaterialFields();
});
els.tintColor.addEventListener('input', () => {
  els.tintHex.value = els.tintColor.value;
  applyReviewMaterialSettings();
});
els.tintHex.addEventListener('input', () => {
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(els.tintHex.value.trim())) {
    els.tintColor.value = els.tintHex.value.trim();
    applyReviewMaterialSettings();
  }
});
els.opacityRange.addEventListener('input', () => {
  els.opacityOut.value = els.opacityRange.value;
  applyReviewMaterialSettings();
});
els.opacityOut.addEventListener('input', () => {
  els.opacityRange.value = els.opacityOut.value;
  applyReviewMaterialSettings();
});
els.applyAllMaterials.addEventListener('change', applyReviewMaterialSettings);
els.copyTextureBtn.addEventListener('click', () => {
  copyTextureFromSelectedMaterial();
});
els.resetMaterialBtn.addEventListener('click', () => {
  resetSelectedReviewMaterials();
});
els.backBtn.addEventListener('click', async () => {
  if (!state.selectedFile) {
    return;
  }
  await loadFbx(state.selectedFile);
});
els.saveFinalBtn.addEventListener('click', async () => {
  await saveFinalGlb();
});

els.exportBtn.addEventListener('click', async () => {
  if (state.mode === 'review') {
    await saveFinalGlb();
    return;
  }

  await generateReviewGlb();
});

window.addEventListener('error', (event) => {
  showError(event.error || event.message || 'Erro desconhecido.');
});

window.addEventListener('unhandledrejection', (event) => {
  showError(event.reason || 'Promise rejeitada.');
});

resize();
render();

setMode('fbx');
setStatus('Choose the FBX folder and click Generate GLB preview.');
