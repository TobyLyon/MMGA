/*
  PFP Generator - Web2-only Editor
  - Fabric.js 2D canvas editor for uploading a photo, adding stickers, transforming, and exporting.
  - Features: drag/scale/rotate, flip H/V, layer up/down, delete, opacity, blend mode, snap-to-center, nudge keys, zoom/pan, undo/redo, presets export, JPG/WebP quality, center-crop option.
  - State: client-side only; session save/load via localStorage.
*/
(function () {
	'use strict';

	/** Global State **/
	let fabricCanvas = null;
	let originalImage = null; // HTMLImageElement or ImageBitmap for original uploaded photo
	let originalImageNaturalWidth = 0;
	let originalImageNaturalHeight = 0;
	let currentZoom = 1;
	const minZoom = 0.1;
	const maxZoom = 5;
	let isPanning = false;
	let lastPosX = 0;
	let lastPosY = 0;
	let spaceKeyActive = false;

	// History for undo/redo
	const historyStack = [];
	const redoStack = [];
	const maxHistory = 50;

	// Elements
	const photoInput = document.getElementById('photoInput');
	const newProjectBtn = document.getElementById('newProjectBtn');
	const saveSessionBtn = document.getElementById('saveSessionBtn');
	const resetBtn = document.getElementById('resetBtn');
	const fitBtn = document.getElementById('fitBtn');
	const oneToOneBtn = document.getElementById('oneToOneBtn');
	const zoomInBtn = document.getElementById('zoomInBtn');
	const zoomOutBtn = document.getElementById('zoomOutBtn');
	const exportBtn = document.getElementById('exportBtn');
	const bringForwardBtn = document.getElementById('bringForwardBtn');
	const sendBackwardBtn = document.getElementById('sendBackwardBtn');
	const flipHBtn = document.getElementById('flipHBtn');
	const flipVBtn = document.getElementById('flipVBtn');
	const deleteBtn = document.getElementById('deleteBtn');
	const opacityRange = document.getElementById('opacityRange');
	const blendModeSelect = document.getElementById('blendModeSelect');
	const stickerSearch = document.getElementById('stickerSearch');
	const stickerTabs = document.getElementById('stickerTabs');
	const stickerGrid = document.getElementById('stickerGrid');
	const floatingTokenBtn = document.getElementById('floatingTokenBtn');

	/** Utility Functions **/
	function showNotification(message, type = 'info') {
		let notif = document.getElementById('notification');
		if (!notif) {
			notif = document.createElement('div');
			notif.id = 'notification';
			notif.className = 'notification';
			document.body.appendChild(notif);
		}
		notif.textContent = message;
		notif.style.borderColor = type === 'error' ? '#ef4444' : type === 'success' ? '#22c55e' : 'rgba(255,255,255,0.3)';
		notif.classList.add('show');
		setTimeout(() => notif.classList.remove('show'), 2000);
	}

	function clamp(value, min, max) {
		return Math.max(min, Math.min(max, value));
	}

	function debounce(fn, delay) {
		let t = null;
		return (...args) => {
			clearTimeout(t);
			t = setTimeout(() => fn.apply(null, args), delay);
		};
	}

	function getTimestamp() {
		const pad = (n) => String(n).padStart(2, '0');
		const d = new Date();
		return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	}

	/** Fabric Setup **/
	function initFabricCanvas() {
		const canvasEl = document.getElementById('editorCanvas');
		if (!canvasEl) {
			console.error('Canvas element not found');
			return;
		}
		fabricCanvas = new fabric.Canvas('editorCanvas', {
			selection: true,
			preserveObjectStacking: true,
			backgroundVpt: true,
			fireRightClick: false,
			stopContextMenu: true,
			uniformScaling: false
		});
		// Configure uniform scaling with Shift
		fabric.Object.prototype.transparentCorners = false;
		fabric.Object.prototype.cornerStyle = 'circle';
		fabric.Object.prototype.cornerColor = '#87CEEB';
		fabric.Object.prototype.borderColor = '#87CEEB';
		fabric.Object.prototype.cornerSize = 10;
		fabric.Object.prototype.padding = 5;
		fabric.Object.prototype.objectCaching = true;
		fabric.Object.prototype.snapAngle = 1;
		fabric.Object.prototype.controls.mtr.withConnection = true;
		// Enable proportional scaling with Shift
		const setUniformFromShift = (eventData, transform) => {
			// Hold Shift to enforce uniform scaling
			transform.target.set('lockUniScaling', !!eventData.shiftKey);
		};
		fabric.Object.prototype.on('scaling', function (opt) {
			setUniformFromShift(opt.e, opt.transform);
		});

		// Wheel zoom
		fabricCanvas.on('mouse:wheel', function (opt) {
			const delta = opt.e.deltaY;
			let zoom = fabricCanvas.getZoom();
			zoom *= Math.pow(0.999, delta);
			zoom = clamp(zoom, minZoom, maxZoom);
			const pointer = fabricCanvas.getPointer(opt.e);
			fabricCanvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
			currentZoom = zoom;
			opt.e.preventDefault();
			opt.e.stopPropagation();
		});

		// Space+drag to pan
		fabricCanvas.on('mouse:down', function (opt) {
			const evt = opt.e;
			if (spaceKeyActive || evt.button === 1) {
				isPanning = true;
				lastPosX = evt.clientX;
				lastPosY = evt.clientY;
				opt.e.preventDefault();
			}
		});
		fabricCanvas.on('mouse:move', function (opt) {
			if (isPanning) {
				const e = opt.e;
				const vpt = fabricCanvas.viewportTransform;
				vpt[4] += e.clientX - lastPosX;
				vpt[5] += e.clientY - lastPosY;
				lastPosX = e.clientX;
				lastPosY = e.clientY;
				fabricCanvas.requestRenderAll();
			}
		});
		fabricCanvas.on('mouse:up', function () {
			isPanning = false;
		});

		// Snap-to-center guidelines
		fabricCanvas.on('object:moving', handleSnapToGuides);
		fabricCanvas.on('object:scaling', handleSnapToGuides);
		fabricCanvas.on('object:rotating', handleSnapToGuides);

		// History on modification
		fabricCanvas.on('object:modified', pushHistory);
		fabricCanvas.on('object:added', pushHistory);
		fabricCanvas.on('object:removed', pushHistory);
	}

	function handleSnapToGuides(opt) {
		const obj = opt.target;
		if (!obj) return;
		const canvasWidth = fabricCanvas.getWidth();
		const canvasHeight = fabricCanvas.getHeight();
		const centerX = canvasWidth / 2;
		const centerY = canvasHeight / 2;
		const threshold = 6 / currentZoom; // adjust by zoom

		// object's center after transform
		const objCenter = obj.getCenterPoint();

		let snapped = false;
		if (Math.abs(objCenter.x - centerX) < threshold) {
			obj.centeredScaling = true;
			obj.setPositionByOrigin(new fabric.Point(centerX, objCenter.y), 'center', 'center');
			snapped = true;
		}
		if (Math.abs(objCenter.y - centerY) < threshold) {
			obj.centeredScaling = true;
			obj.setPositionByOrigin(new fabric.Point(objCenter.x, centerY), 'center', 'center');
			snapped = true;
		}
		if (snapped) fabricCanvas.requestRenderAll();
	}

	function setCanvasSizeToPhotoPreview() {
		if (!originalImage) return;
		const maxPreviewEdge = 800; // higher-quality preview; CSS contains container
		const aspect = originalImageNaturalWidth / originalImageNaturalHeight;
		let w, h;
		if (aspect >= 1) {
			w = Math.min(maxPreviewEdge, originalImageNaturalWidth);
			h = Math.round(w / aspect);
		} else {
			h = Math.min(maxPreviewEdge, originalImageNaturalHeight);
			w = Math.round(h * aspect);
		}
		fabricCanvas.setWidth(w);
		fabricCanvas.setHeight(h);
		fitToView();
	}

	function fitToView() {
		const canvasEl = fabricCanvas.getElement();
		const parent = canvasEl.parentElement;
		if (!parent) return;
		const padding = 40; // match .canvas-wrapper padding roughly
		const availW = parent.clientWidth - padding * 2;
		const availH = parent.clientHeight - padding * 2;
		const zoomX = availW / fabricCanvas.getWidth();
		const zoomY = availH / fabricCanvas.getHeight();
		const zoom = clamp(Math.min(zoomX, zoomY, 1.5), minZoom, maxZoom);
		fabricCanvas.setViewportTransform([zoom, 0, 0, zoom, 0, 0]);
		currentZoom = zoom;
		fabricCanvas.requestRenderAll();
	}

	function setOneToOne() {
		fabricCanvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
		currentZoom = 1;
		fabricCanvas.requestRenderAll();
	}

	/** Loaders **/
	async function decodeImageFromFile(file) {
		return new Promise((resolve, reject) => {
			try {
				const url = URL.createObjectURL(file);
				const img = new Image();
				img.crossOrigin = 'anonymous';
				img.onload = () => resolve({ img, url });
				img.onerror = () => reject(new Error('Failed to decode image'));
				img.src = url;
			} catch (e) {
				reject(e);
			}
		});
	}

	async function setBackgroundFromFile(file) {
		try {
			const { img, url } = await decodeImageFromFile(file);
			originalImage = img;
			originalImageNaturalWidth = img.naturalWidth;
			originalImageNaturalHeight = img.naturalHeight;
			setCanvasSizeToPhotoPreview();
			await setFabricBackground(img);
			URL.revokeObjectURL(url);
			showNotification('Photo loaded', 'success');
			// Hide canvas instructions
			const instructions = document.getElementById('canvasInstructions');
			if (instructions) instructions.classList.add('hidden');
		} catch (err) {
			console.error(err);
			showNotification('Unsupported image format. HEIC may not be supported by your browser.', 'error');
		}
	}

	async function setFabricBackground(img) {
		return new Promise((resolve) => {
			const fabricImg = new fabric.Image(img, {
				selectable: false,
				evented: false,
				objectCaching: true
			});
			// Scale background to fit canvas (contain) without deformation
			const canvasW = fabricCanvas.getWidth();
			const canvasH = fabricCanvas.getHeight();
			const scale = Math.min(canvasW / img.naturalWidth, canvasH / img.naturalHeight);
			fabricImg.scale(scale);
			fabricImg.set({ left: (canvasW - img.naturalWidth * scale) / 2, top: (canvasH - img.naturalHeight * scale) / 2 });
			fabricCanvas.setBackgroundImage(fabricImg, () => {
				fabricCanvas.requestRenderAll();
				pushHistory();
				resolve();
			});
		});
	}

	/** Stickers **/
	let packsData = null;
	let currentPackId = null;

	async function loadStickerPacks() {
		try {
			const res = await fetch('stickers/packs.json', { cache: 'no-cache' });
			packsData = await res.json();
			renderPackTabs(packsData.packs || []);
			if (packsData.packs && packsData.packs.length) {
				selectPack(packsData.packs[0].id);
			}
		} catch (e) {
			console.error('Failed to load sticker packs:', e);
		}
	}

	function renderPackTabs(packs) {
		stickerTabs.innerHTML = '';
		packs.forEach((p) => {
			const btn = document.createElement('button');
			btn.className = 'btn btn-secondary';
			btn.setAttribute('role', 'tab');
			btn.setAttribute('data-pack-id', p.id);
			btn.textContent = p.name || p.id;
			btn.onclick = () => selectPack(p.id);
			stickerTabs.appendChild(btn);
		});
	}

	function selectPack(packId) {
		currentPackId = packId;
		// set active tab state
		Array.from(stickerTabs.children).forEach((el) => {
			const isActive = el.getAttribute('data-pack-id') === packId;
			el.setAttribute('aria-selected', isActive ? 'true' : 'false');
			el.classList.toggle('active', isActive);
		});
		renderStickerGrid();
	}

	const renderStickerGrid = debounce(() => {
		if (!packsData) return;
		const pack = (packsData.packs || []).find((p) => p.id === currentPackId);
		const items = (pack && pack.items) || [];
		const q = (stickerSearch.value || '').toLowerCase();
		stickerGrid.innerHTML = '';
		items
			.filter((it) => !q || (it.id || '').toLowerCase().includes(q))
			.forEach((it) => {
				const card = document.createElement('div');
				card.className = 'trait-card';
				card.title = it.id;
				card.setAttribute('draggable', 'true');
				card.ondragstart = (e) => {
					e.dataTransfer.setData('text/plain', JSON.stringify(it));
				};
				card.onclick = () => addStickerToCanvas(it);
				const img = document.createElement('img');
				img.className = 'trait-thumb';
				img.loading = 'lazy';
				img.alt = it.id;
				img.src = it.thumb || it.src;
				img.onerror = () => {
					console.error('Failed to load sticker image:', it.id, img.src);
					img.style.display = 'none';
				};
				const label = document.createElement('div');
				label.className = 'trait-name';
				label.textContent = it.id;
				card.appendChild(img);
				card.appendChild(label);
				stickerGrid.appendChild(card);
			});
	}, 150);

	// Drag/drop from library into canvas
	stickerGrid.addEventListener('drop', function (e) {
		try {
			const data = e.dataTransfer.getData('text/plain');
			if (data) addStickerToCanvas(JSON.parse(data));
		} catch {}
	});
	stickerGrid.addEventListener('dragover', function (e) {
		e.preventDefault();
	});

	function addStickerToCanvas(item) {
		if (!item || !item.src) return;
		fabric.Image.fromURL(item.src, function (img) {
			img.set({
				left: fabricCanvas.getWidth() / 2,
				top: fabricCanvas.getHeight() / 2,
				originX: 'center',
				originY: 'center',
				selectable: true,
				objectCaching: true,
				globalCompositeOperation: 'source-over'
			});
			const defaultScale = item.defaultScale || 0.25;
			const targetWidth = fabricCanvas.getWidth() * defaultScale;
			const scale = targetWidth / img.width;
			img.scale(scale);
			img.set('data', { stickerId: item.id || '', blend: 'source-over' });
			fabricCanvas.add(img);
			fabricCanvas.setActiveObject(img);
			fabricCanvas.requestRenderAll();
			pushHistory();
		});
	}

	/** Toolbar Actions **/
	function getActiveObject() {
		return fabricCanvas.getActiveObject();
	}

	function bringForward() {
		const obj = getActiveObject();
		if (!obj) return;
		fabricCanvas.bringForward(obj, true);
		fabricCanvas.requestRenderAll();
	}

	function sendBackward() {
		const obj = getActiveObject();
		if (!obj) return;
		fabricCanvas.sendBackwards(obj, true);
		fabricCanvas.requestRenderAll();
	}

	function flipHorizontal() {
		const obj = getActiveObject();
		if (!obj) return;
		obj.set('flipX', !obj.flipX);
		fabricCanvas.requestRenderAll();
	}

	function flipVertical() {
		const obj = getActiveObject();
		if (!obj) return;
		obj.set('flipY', !obj.flipY);
		fabricCanvas.requestRenderAll();
	}

	function deleteSelected() {
		const obj = getActiveObject();
		if (!obj) return;
		fabricCanvas.remove(obj);
		fabricCanvas.discardActiveObject();
		fabricCanvas.requestRenderAll();
	}

	function setOpacity(val) {
		const obj = getActiveObject();
		if (!obj) return;
		obj.set('opacity', clamp(parseFloat(val) || 1, 0, 1));
		fabricCanvas.requestRenderAll();
	}

	function setBlendMode(val) {
		const obj = getActiveObject();
		if (!obj) return;
		obj.set('globalCompositeOperation', val);
		if (obj.data) obj.data.blend = val;
		fabricCanvas.requestRenderAll();
	}

	/** Keyboard **/
	function onKeyDown(e) {
		// Ignore when typing in inputs or contenteditable
		const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
		if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
		if (e.key === ' ' ) {
			spaceKeyActive = true;
		}
		const obj = getActiveObject();
		if (e.key === 'Delete' || e.key === 'Backspace') {
			if (obj) {
				deleteSelected();
				e.preventDefault();
			}
		}
		if (!obj) return;
		const nudge = e.shiftKey ? 10 : 1;
		switch (e.key) {
			case 'ArrowLeft':
				obj.left -= nudge;
				break;
			case 'ArrowRight':
				obj.left += nudge;
				break;
			case 'ArrowUp':
				obj.top -= nudge;
				break;
			case 'ArrowDown':
				obj.top += nudge;
				break;
			default:
				break;
		}
		if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
			obj.setCoords();
			fabricCanvas.requestRenderAll();
			e.preventDefault();
		}
		// Duplicate: Ctrl/Cmd + D
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
			obj.clone((cloned) => {
				cloned.set({ left: (obj.left || 0) + 20, top: (obj.top || 0) + 20 });
				fabricCanvas.add(cloned);
				fabricCanvas.setActiveObject(cloned);
				fabricCanvas.requestRenderAll();
				pushHistory();
			});
			e.preventDefault();
		}
		// Undo/Redo
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
			doUndo();
			e.preventDefault();
		}
		if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
			doRedo();
			e.preventDefault();
		}
	}
	function onKeyUp(e) {
		if (e.key === ' ') {
			spaceKeyActive = false;
		}
	}

	/** Undo/Redo **/
	function pushHistory() {
		try {
			const json = fabricCanvas.toDatalessJSON(['data', 'globalCompositeOperation']);
			historyStack.push(json);
			if (historyStack.length > maxHistory) historyStack.shift();
			redoStack.length = 0;
		} catch {}
	}
	function doUndo() {
		if (historyStack.length <= 1) return;
		const current = historyStack.pop();
		redoStack.push(current);
		const prev = historyStack[historyStack.length - 1];
		fabricCanvas.loadFromJSON(prev, () => fabricCanvas.requestRenderAll());
	}
	function doRedo() {
		if (!redoStack.length) return;
		const next = redoStack.pop();
		historyStack.push(next);
		fabricCanvas.loadFromJSON(next, () => fabricCanvas.requestRenderAll());
	}

	/** Export **/
	function openExportDialog() {
		const dialog = document.createElement('div');
		dialog.style.position = 'fixed';
		dialog.style.inset = '0';
		dialog.style.background = 'rgba(0,0,0,0.6)';
		dialog.style.display = 'flex';
		dialog.style.alignItems = 'center';
		dialog.style.justifyContent = 'center';
		dialog.style.zIndex = '10000';
		const card = document.createElement('div');
		card.style.background = 'rgba(15,20,25,0.95)';
		card.style.border = '1px solid rgba(135,206,235,0.4)';
		card.style.borderRadius = '12px';
		card.style.padding = '16px';
		card.style.minWidth = '320px';
		card.style.maxWidth = '90vw';
		card.style.color = '#fff';
		card.innerHTML = `
			<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px;">
				<h3 style="margin:0; font-size:18px;">Export</h3>
				<button class="btn btn-ghost" id="exportCloseBtn">✕</button>
			</div>
			<div style="display:grid; gap:10px;">
				<label style="display:flex; gap:8px; align-items:center; justify-content:space-between;">
					<span>Size</span>
					<select id="exportSize" class="btn btn-secondary">
						<option value="original">Original (${originalImageNaturalWidth}×${originalImageNaturalHeight})</option>
						<option value="512">512×512</option>
						<option value="1024">1024×1024</option>
						<option value="1500">1500×1500</option>
						<option value="1080">1080×1080 (IG)</option>
						<option value="400">400×400 (X/Twitter)</option>
						<option value="128">128×128 (Discord)</option>
					</select>
				</label>
				<label style="display:flex; gap:8px; align-items:center; justify-content:space-between;">
					<span>Format</span>
					<select id="exportFormat" class="btn btn-secondary">
						<option value="png">PNG</option>
						<option value="jpg">JPG</option>
						<option value="webp">WebP</option>
					</select>
				</label>
				<div id="qualityRow" style="display:flex; gap:8px; align-items:center; justify-content:space-between;">
					<span>Quality</span>
					<input type="range" id="exportQuality" min="0" max="1" step="0.01" value="0.6" style="width:160px;" />
				</div>
				<label style="display:flex; gap:8px; align-items:center;">
					<input type="checkbox" id="exportCenterCrop" />
					<span>Center-crop to square</span>
				</label>
				<button class="btn btn-primary" id="exportGoBtn">Download</button>
			</div>
		`;
		dialog.appendChild(card);
		document.body.appendChild(dialog);

		const formatSel = card.querySelector('#exportFormat');
		const qualityRow = card.querySelector('#qualityRow');
		const qualityInput = card.querySelector('#exportQuality');
		function updateQualityVisibility() {
			const fmt = formatSel.value;
			qualityRow.style.display = (fmt === 'jpg' || fmt === 'webp') ? 'flex' : 'none';
		}
		formatSel.onchange = updateQualityVisibility;
		updateQualityVisibility();

		card.querySelector('#exportCloseBtn').onclick = () => dialog.remove();
		card.querySelector('#exportGoBtn').onclick = async () => {
			const sizeSel = card.querySelector('#exportSize').value;
			const fmt = formatSel.value;
			const cropSquare = card.querySelector('#exportCenterCrop').checked;
			const quality = parseFloat(qualityInput.value || '0.6');
			try {
				const { blob, width, height, ext } = await exportImage({ sizeSel, fmt, cropSquare, quality });
				const a = document.createElement('a');
				const ts = getTimestamp();
				const filename = `pfp_${width}x${height}_${ts}.${ext}`;
				a.href = URL.createObjectURL(blob);
				a.download = filename;
				a.click();
				URL.revokeObjectURL(a.href);
				showNotification('Exported', 'success');
				dialog.remove();
			} catch (e) {
				console.error(e);
				showNotification('Export failed', 'error');
			}
		};
	}

	async function exportImage({ sizeSel, fmt, cropSquare, quality }) {
		if (!originalImage) throw new Error('No photo loaded');
		let outW, outH;
		if (sizeSel === 'original') {
			outW = originalImageNaturalWidth;
			outH = originalImageNaturalHeight;
		} else {
			const s = parseInt(sizeSel, 10);
			outW = s;
			outH = s;
		}

		// Prepare an offscreen Fabric StaticCanvas for crisp output
		const staticCanvas = new fabric.StaticCanvas(null, { width: outW, height: outH, enableRetinaScaling: false });

		// Background photo: scale to cover (if cropSquare) or contain
		const bgImage = new fabric.Image(originalImage, { selectable: false, evented: false });
		const cover = !!cropSquare;
		const scale = cover
			? Math.max(outW / originalImageNaturalWidth, outH / originalImageNaturalHeight)
			: Math.min(outW / originalImageNaturalWidth, outH / originalImageNaturalHeight);
		bgImage.scale(scale);
		bgImage.set({ left: (outW - originalImageNaturalWidth * scale) / 2, top: (outH - originalImageNaturalHeight * scale) / 2 });
		staticCanvas.add(bgImage);

		// Map stickers from preview coordinates to export coordinates
		const previewW = fabricCanvas.getWidth();
		const previewH = fabricCanvas.getHeight();
		const exportScaleX = outW / previewW;
		const exportScaleY = outH / previewH;
		const objs = fabricCanvas.getObjects().filter((o) => o !== fabricCanvas.backgroundImage);
		for (const o of objs) {
			// Only handle images (stickers)
			if (o.type !== 'image') continue;
			const clone = fabric.util.object.clone(o);
			clone.set({
				left: (o.left || 0) * exportScaleX,
				top: (o.top || 0) * exportScaleY,
				scaleX: (o.scaleX || 1) * exportScaleX,
				scaleY: (o.scaleY || 1) * exportScaleY,
				originX: o.originX,
				originY: o.originY,
				angle: o.angle || 0,
				flipX: !!o.flipX,
				flipY: !!o.flipY,
				opacity: o.opacity == null ? 1 : o.opacity,
				globalCompositeOperation: o.globalCompositeOperation || 'source-over'
			});
			staticCanvas.add(clone);
		}

		staticCanvas.renderAll();

		// If output is JPG, set opaque white background to avoid black transparency
		if (fmt === 'jpg') {
			const ctx = staticCanvas.getContext();
			const imageData = ctx.getImageData(0, 0, outW, outH);
			const tmpCanvas = document.createElement('canvas');
			tmpCanvas.width = outW;
			tmpCanvas.height = outH;
			const tctx = tmpCanvas.getContext('2d');
			tctx.fillStyle = '#ffffff';
			tctx.fillRect(0, 0, outW, outH);
			tctx.putImageData(imageData, 0, 0);
			const blob = await new Promise((resolve) => tmpCanvas.toBlob(resolve, 'image/jpeg', clamp(quality, 0, 1)));
			return { blob, width: outW, height: outH, ext: 'jpg' };
		}
		if (fmt === 'webp') {
			const blob = await new Promise((resolve) => staticCanvas.toCanvasElement().toBlob(resolve, 'image/webp', clamp(quality, 0, 1)));
			return { blob, width: outW, height: outH, ext: 'webp' };
		}
		// PNG default
		const blob = await new Promise((resolve) => staticCanvas.toCanvasElement().toBlob(resolve, 'image/png'));
		return { blob, width: outW, height: outH, ext: 'png' };
	}

	/** Session **/
	function saveSession() {
		if (!originalImage) {
			showNotification('No session to save', 'error');
			return;
		}
		try {
			const json = fabricCanvas.toDatalessJSON(['data', 'globalCompositeOperation']);
			// Snapshot original image as data URL (may be large)
			const tmp = document.createElement('canvas');
			tmp.width = originalImageNaturalWidth;
			tmp.height = originalImageNaturalHeight;
			const tctx = tmp.getContext('2d');
			tctx.drawImage(originalImage, 0, 0);
			const originalDataURL = tmp.toDataURL('image/png');
			const session = {
				originalImage: originalDataURL,
				originalImageNaturalWidth,
				originalImageNaturalHeight,
				fabric: json
			};
			localStorage.setItem('pfp_session', JSON.stringify(session));
			showNotification('Session saved', 'success');
		} catch (e) {
			console.error(e);
			showNotification('Failed to save session', 'error');
		}
	}

	async function loadSessionIfAny() {
		try {
			const raw = localStorage.getItem('pfp_session');
			if (!raw) return;
			const session = JSON.parse(raw);
			const img = new Image();
			img.onload = async () => {
				originalImage = img;
				originalImageNaturalWidth = session.originalImageNaturalWidth;
				originalImageNaturalHeight = session.originalImageNaturalHeight;
				setCanvasSizeToPhotoPreview();
				await setFabricBackground(img);
				fabricCanvas.loadFromJSON(session.fabric, () => fabricCanvas.requestRenderAll());
				showNotification('Session loaded');
			};
			img.src = session.originalImage;
		} catch {}
	}

	function resetProject() {
		if (!fabricCanvas) return;
		fabricCanvas.clear();
		fabricCanvas.setBackgroundImage(null, () => {});
		originalImage = null;
		originalImageNaturalWidth = 0;
		originalImageNaturalHeight = 0;
		setOneToOne();
		showNotification('Project reset');
		// Show canvas instructions again
		const instructions = document.getElementById('canvasInstructions');
		if (instructions) instructions.classList.remove('hidden');
	}

	/** Token Copy **/
	const TOKEN_ADDRESS = '87B6mb9KBjaF5NHrB3H33f7grdUHi4oWmMErjhZ5bonk';
	function copyTokenAddress() {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(TOKEN_ADDRESS).then(() => {
				showNotification('Token address copied!', 'success');
			}).catch(() => {
				fallbackCopy();
			});
		} else {
			fallbackCopy();
		}
	}
	function fallbackCopy() {
		const textarea = document.createElement('textarea');
		textarea.value = TOKEN_ADDRESS;
		textarea.style.position = 'fixed';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.select();
		try {
			document.execCommand('copy');
			showNotification('Token address copied!', 'success');
		} catch (err) {
			showNotification('Failed to copy', 'error');
		}
		document.body.removeChild(textarea);
	}

	/** Wiring **/
	function wireUI() {
		const copyTokenBtn = document.getElementById('copyTokenBtn');
		copyTokenBtn?.addEventListener('click', copyTokenAddress);
		floatingTokenBtn?.addEventListener('click', copyTokenAddress);

		photoInput?.addEventListener('change', async (e) => {
			const file = e.target.files && e.target.files[0];
			if (!file) return;
			await setBackgroundFromFile(file);
			e.target.value = '';
		});
		newProjectBtn?.addEventListener('click', () => {
			resetProject();
			localStorage.removeItem('pfp_session');
		});
		saveSessionBtn?.addEventListener('click', saveSession);
		resetBtn?.addEventListener('click', resetProject);
		fitBtn?.addEventListener('click', fitToView);
		oneToOneBtn?.addEventListener('click', setOneToOne);
		zoomInBtn?.addEventListener('click', () => {
			const z = clamp(currentZoom * 1.2, minZoom, maxZoom);
			fabricCanvas.zoomToPoint(new fabric.Point(fabricCanvas.getWidth()/2, fabricCanvas.getHeight()/2), z);
			currentZoom = z;
		});
		zoomOutBtn?.addEventListener('click', () => {
			const z = clamp(currentZoom / 1.2, minZoom, maxZoom);
			fabricCanvas.zoomToPoint(new fabric.Point(fabricCanvas.getWidth()/2, fabricCanvas.getHeight()/2), z);
			currentZoom = z;
		});
		exportBtn?.addEventListener('click', openExportDialog);
		bringForwardBtn?.addEventListener('click', bringForward);
		sendBackwardBtn?.addEventListener('click', sendBackward);
		flipHBtn?.addEventListener('click', flipHorizontal);
		flipVBtn?.addEventListener('click', flipVertical);
		deleteBtn?.addEventListener('click', deleteSelected);
		opacityRange?.addEventListener('input', (e) => setOpacity(e.target.value));
		blendModeSelect?.addEventListener('change', (e) => setBlendMode(e.target.value));
		stickerSearch?.addEventListener('input', renderStickerGrid);

		document.addEventListener('keydown', onKeyDown);
		document.addEventListener('keyup', onKeyUp);
	}

	/** Start **/
	window.addEventListener('DOMContentLoaded', async () => {
		initFabricCanvas();
		wireUI();
		await loadStickerPacks();
		await loadSessionIfAny();
		initHatRain();
	});

	/** Hat Rain Effect **/
	function initHatRain() {
		const hatRainContainer = document.getElementById('hatRain');
		if (!hatRainContainer) return;

		const numHats = 15; // Number of falling hats
		
		for (let i = 0; i < numHats; i++) {
			createFallingHat(hatRainContainer, i);
		}
	}

	function createFallingHat(container, index) {
		const hat = document.createElement('div');
		hat.className = 'hat';
		
		// Random horizontal position
		const leftPos = Math.random() * 100;
		hat.style.left = leftPos + '%';
		
		// Random animation duration (speed)
		const duration = 8 + Math.random() * 12; // 8-20 seconds
		hat.style.animationDuration = duration + 's';
		
		// Random delay to stagger the hats
		const delay = Math.random() * 10;
		hat.style.animationDelay = delay + 's';
		
		// Random size variation
		const size = 30 + Math.random() * 30; // 30-60px
		hat.style.width = size + 'px';
		hat.style.height = size + 'px';
		
		container.appendChild(hat);
	}

	// Fade out hat rain on scroll
	window.addEventListener('scroll', () => {
		const hatRainContainer = document.getElementById('hatRain');
		if (!hatRainContainer) return;
		
		const scrollY = window.scrollY;
		const windowHeight = window.innerHeight;
		
		// Fade out as user scrolls down
		if (scrollY < windowHeight) {
			const opacity = Math.max(0, 1 - (scrollY / windowHeight) * 1.5);
			hatRainContainer.style.opacity = opacity;
		} else {
			hatRainContainer.style.opacity = 0;
		}
	});
})();


