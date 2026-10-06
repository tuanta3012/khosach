import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Crop,
  RotateCw,
  Maximize2,
  X,
  Sparkles,
  Columns,
  Rows,
} from 'lucide-react';

interface ImageCropModalProps {
  isOpen: boolean;
  imageSrc: string;
  onConfirmCrop: (croppedImageSrc: string) => void;
  onSkipCrop: (originalImageSrc: string) => void;
  onCancel: () => void;
}

interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rotateBase64Image(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(dataUrl);

      canvas.width = img.height;
      canvas.height = img.width;

      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((90 * Math.PI) / 180);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);

      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function cropBase64Image(dataUrl: string, cropPercent: CropBox): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(dataUrl);

      const imgW = img.naturalWidth || img.width;
      const imgH = img.naturalHeight || img.height;

      const actualX = Math.round((cropPercent.x / 100) * imgW);
      const actualY = Math.round((cropPercent.y / 100) * imgH);
      const actualW = Math.round((cropPercent.width / 100) * imgW);
      const actualH = Math.round((cropPercent.height / 100) * imgH);

      const clampedX = Math.max(0, Math.min(actualX, imgW - 10));
      const clampedY = Math.max(0, Math.min(actualY, imgH - 10));
      const clampedW = Math.max(20, Math.min(actualW, imgW - clampedX));
      const clampedH = Math.max(20, Math.min(actualH, imgH - clampedY));

      canvas.width = clampedW;
      canvas.height = clampedH;

      ctx.drawImage(
        img,
        clampedX,
        clampedY,
        clampedW,
        clampedH,
        0,
        0,
        clampedW,
        clampedH
      );

      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

export const ImageCropModal: React.FC<ImageCropModalProps> = ({
  isOpen,
  imageSrc,
  onConfirmCrop,
  onSkipCrop,
  onCancel,
}) => {
  const [currentImageSrc, setCurrentImageSrc] = useState(imageSrc);
  const [isRotating, setIsRotating] = useState(false);
  const [isProcessingCrop, setIsProcessingCrop] = useState(false);

  const [cropBox, setCropBox] = useState<CropBox>({
    x: 8,
    y: 8,
    width: 84,
    height: 84,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const dragStateRef = useRef<{
    mode: 'move' | 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r' | null;
    startX: number;
    startY: number;
    startCrop: CropBox;
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    startCrop: cropBox,
  });

  useEffect(() => {
    if (imageSrc) {
      setCurrentImageSrc(imageSrc);
      setCropBox({
        x: 8,
        y: 8,
        width: 84,
        height: 84,
      });
    }
  }, [imageSrc, isOpen]);

  const handleRotate = async () => {
    if (isRotating || !currentImageSrc) return;
    setIsRotating(true);
    try {
      const rotated = await rotateBase64Image(currentImageSrc);
      setCurrentImageSrc(rotated);
      setCropBox({
        x: 8,
        y: 8,
        width: 84,
        height: 84,
      });
    } catch (err) {
      console.error('Lỗi khi xoay ảnh:', err);
    } finally {
      setIsRotating(false);
    }
  };

  const handleSetPreset = (preset: 'full' | 'spine' | 'shelf') => {
    if (preset === 'full') {
      setCropBox({ x: 2, y: 2, width: 96, height: 96 });
    } else if (preset === 'spine') {
      setCropBox({ x: 25, y: 10, width: 50, height: 80 });
    } else if (preset === 'shelf') {
      setCropBox({ x: 5, y: 25, width: 90, height: 50 });
    }
  };

  const handlePointerDown = (
    e: React.PointerEvent,
    mode: 'move' | 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r'
  ) => {
    e.preventDefault();
    e.stopPropagation();

    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    dragStateRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startCrop: { ...cropBox },
    };
  };

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const { mode, startX, startY, startCrop } = dragStateRef.current;
    if (!mode || !imageRef.current) return;

    const imgRect = imageRef.current.getBoundingClientRect();
    if (imgRect.width === 0 || imgRect.height === 0) return;

    const deltaXPercent = ((e.clientX - startX) / imgRect.width) * 100;
    const deltaYPercent = ((e.clientY - startY) / imgRect.height) * 100;

    let newCrop = { ...startCrop };
    const MIN_SIZE = 12;

    if (mode === 'move') {
      newCrop.x = Math.max(0, Math.min(startCrop.x + deltaXPercent, 100 - startCrop.width));
      newCrop.y = Math.max(0, Math.min(startCrop.y + deltaYPercent, 100 - startCrop.height));
    } else if (mode === 'br') {
      newCrop.width = Math.max(MIN_SIZE, Math.min(startCrop.width + deltaXPercent, 100 - startCrop.x));
      newCrop.height = Math.max(MIN_SIZE, Math.min(startCrop.height + deltaYPercent, 100 - startCrop.y));
    } else if (mode === 'bl') {
      const maxDeltaX = startCrop.width - MIN_SIZE;
      const actualDeltaX = Math.min(Math.max(deltaXPercent, -startCrop.x), maxDeltaX);
      newCrop.x = startCrop.x + actualDeltaX;
      newCrop.width = startCrop.width - actualDeltaX;
      newCrop.height = Math.max(MIN_SIZE, Math.min(startCrop.height + deltaYPercent, 100 - startCrop.y));
    } else if (mode === 'tr') {
      newCrop.width = Math.max(MIN_SIZE, Math.min(startCrop.width + deltaXPercent, 100 - startCrop.x));
      const maxDeltaY = startCrop.height - MIN_SIZE;
      const actualDeltaY = Math.min(Math.max(deltaYPercent, -startCrop.y), maxDeltaY);
      newCrop.y = startCrop.y + actualDeltaY;
      newCrop.height = startCrop.height - actualDeltaY;
    } else if (mode === 'tl') {
      const maxDeltaX = startCrop.width - MIN_SIZE;
      const actualDeltaX = Math.min(Math.max(deltaXPercent, -startCrop.x), maxDeltaX);
      newCrop.x = startCrop.x + actualDeltaX;
      newCrop.width = startCrop.width - actualDeltaX;

      const maxDeltaY = startCrop.height - MIN_SIZE;
      const actualDeltaY = Math.min(Math.max(deltaYPercent, -startCrop.y), maxDeltaY);
      newCrop.y = startCrop.y + actualDeltaY;
      newCrop.height = startCrop.height - actualDeltaY;
    } else if (mode === 't') {
      const maxDeltaY = startCrop.height - MIN_SIZE;
      const actualDeltaY = Math.min(Math.max(deltaYPercent, -startCrop.y), maxDeltaY);
      newCrop.y = startCrop.y + actualDeltaY;
      newCrop.height = startCrop.height - actualDeltaY;
    } else if (mode === 'b') {
      newCrop.height = Math.max(MIN_SIZE, Math.min(startCrop.height + deltaYPercent, 100 - startCrop.y));
    } else if (mode === 'l') {
      const maxDeltaX = startCrop.width - MIN_SIZE;
      const actualDeltaX = Math.min(Math.max(deltaXPercent, -startCrop.x), maxDeltaX);
      newCrop.x = startCrop.x + actualDeltaX;
      newCrop.width = startCrop.width - actualDeltaX;
    } else if (mode === 'r') {
      newCrop.width = Math.max(MIN_SIZE, Math.min(startCrop.width + deltaXPercent, 100 - startCrop.x));
    }

    setCropBox(newCrop);
  }, []);

  const handlePointerUp = (e: React.PointerEvent) => {
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    dragStateRef.current.mode = null;
  };

  const handleConfirm = async () => {
    if (isProcessingCrop || !currentImageSrc) return;
    setIsProcessingCrop(true);
    try {
      const cropped = await cropBase64Image(currentImageSrc, cropBox);
      onConfirmCrop(cropped);
    } catch (err) {
      console.error('Lỗi khi thực hiện crop:', err);
      onConfirmCrop(currentImageSrc);
    } finally {
      setIsProcessingCrop(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-xs transition-all">
      <div className="relative w-full max-w-2xl bg-white border border-slate-200 rounded-3xl shadow-2xl flex flex-col overflow-hidden max-h-[96vh] text-slate-800">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-white shrink-0">
          <div className="flex items-center gap-2">
            <span className="p-1.5 bg-[#9e5628]/10 text-[#9e5628] rounded-xl shadow-3xs">
              <Crop className="w-4 h-4" />
            </span>
            <div>
              <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5">
                <span>Cắt đúng phần muốn OCR</span>
              </h3>
              <p className="text-[11px] text-slate-500 hidden sm:block">
                Kéo khung để chọn vùng kệ sách hoặc gáy sách cần bóc tách
              </p>
            </div>
          </div>

          <button
            onClick={onCancel}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 active:scale-95 transition cursor-pointer"
            title="Đóng / Hủy"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Preset Toolbar: 4 nút biểu tượng cân đối trong 1 hàng */}
        <div className="grid grid-cols-4 gap-2 px-3 sm:px-4 py-2 border-b border-slate-100 bg-slate-50 shrink-0">
          <button
            type="button"
            onClick={() => handleSetPreset('full')}
            className="h-10 flex items-center justify-center rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 transition shadow-3xs active:scale-95 cursor-pointer"
            title="Toàn ảnh (Chọn tất cả)"
            aria-label="Toàn ảnh"
          >
            <Maximize2 className="w-5 h-5 text-[#9e5628]" />
          </button>

          <button
            type="button"
            onClick={() => handleSetPreset('shelf')}
            className="h-10 flex items-center justify-center rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 transition shadow-3xs active:scale-95 cursor-pointer"
            title="Khung kệ ngang"
            aria-label="Kệ ngang"
          >
            <Rows className="w-5 h-5 text-[#9e5628]" />
          </button>

          <button
            type="button"
            onClick={() => handleSetPreset('spine')}
            className="h-10 flex items-center justify-center rounded-xl bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 transition shadow-3xs active:scale-95 cursor-pointer"
            title="Khung gáy đứng"
            aria-label="Gáy đứng"
          >
            <Columns className="w-5 h-5 text-purple-600" />
          </button>

          <button
            type="button"
            onClick={handleRotate}
            disabled={isRotating}
            className="h-10 flex items-center justify-center rounded-xl bg-[#10B981] hover:bg-[#059669] text-white border border-transparent transition shadow-3xs active:scale-95 cursor-pointer disabled:opacity-50"
            title="Xoay ảnh 90°"
            aria-label="Xoay ảnh 90°"
          >
            <RotateCw className={`w-5 h-5 ${isRotating ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Interactive Canvas */}
        <div
          ref={containerRef}
          className="relative flex-1 bg-slate-900 p-2 sm:p-4 flex items-center justify-center overflow-hidden min-h-[300px] max-h-[60vh] select-none touch-none"
        >
          {currentImageSrc && (
            <div className="relative inline-block max-w-full max-h-full">
              <img
                ref={imageRef}
                src={currentImageSrc}
                alt="Chụp để OCR"
                className="max-w-full max-h-[56vh] object-contain block mx-auto pointer-events-none rounded-lg"
              />

              {/* Crop Box with Warm Sienna / Amber Highlight */}
              <div
                className="absolute border-2 border-amber-400 bg-amber-500/15 cursor-move shadow-[0_0_0_9999px_rgba(0,0,0,0.7)]"
                style={{
                  left: `${cropBox.x}%`,
                  top: `${cropBox.y}%`,
                  width: `${cropBox.width}%`,
                  height: `${cropBox.height}%`,
                }}
                onPointerDown={(e) => handlePointerDown(e, 'move')}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              >
                {/* Rule of Thirds Grid */}
                <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none">
                  <div className="border-r border-b border-white/30" />
                  <div className="border-r border-b border-white/30" />
                  <div className="border-b border-white/30" />
                  <div className="border-r border-b border-white/30" />
                  <div className="border-r border-b border-white/30" />
                  <div className="border-b border-white/30" />
                  <div className="border-r border-white/30" />
                  <div className="border-r border-white/30" />
                  <div />
                </div>

                {/* Corner Handles */}
                <div
                  className="absolute -top-3.5 -left-3.5 w-7 h-7 flex items-center justify-center cursor-nwse-resize z-20 touch-none"
                  onPointerDown={(e) => handlePointerDown(e, 'tl')}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                >
                  <div className="w-3.5 h-3.5 bg-amber-400 border-2 border-slate-950 rounded-sm shadow-md" />
                </div>

                <div
                  className="absolute -top-3.5 -right-3.5 w-7 h-7 flex items-center justify-center cursor-nesw-resize z-20 touch-none"
                  onPointerDown={(e) => handlePointerDown(e, 'tr')}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                >
                  <div className="w-3.5 h-3.5 bg-amber-400 border-2 border-slate-950 rounded-sm shadow-md" />
                </div>

                <div
                  className="absolute -bottom-3.5 -left-3.5 w-7 h-7 flex items-center justify-center cursor-nesw-resize z-20 touch-none"
                  onPointerDown={(e) => handlePointerDown(e, 'bl')}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                >
                  <div className="w-3.5 h-3.5 bg-amber-400 border-2 border-slate-950 rounded-sm shadow-md" />
                </div>

                <div
                  className="absolute -bottom-3.5 -right-3.5 w-7 h-7 flex items-center justify-center cursor-nwse-resize z-20 touch-none"
                  onPointerDown={(e) => handlePointerDown(e, 'br')}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                >
                  <div className="w-3.5 h-3.5 bg-amber-400 border-2 border-slate-950 rounded-sm shadow-md" />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-4 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between gap-2 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-2 rounded-xl text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 text-xs font-bold transition active:scale-95 cursor-pointer"
          >
            Chụp lại
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSkipCrop(currentImageSrc)}
              className="px-3 py-2 rounded-xl bg-white hover:bg-slate-100 text-slate-700 text-xs font-bold transition border border-slate-200 shadow-3xs active:scale-95 cursor-pointer"
            >
              Dùng toàn ảnh
            </button>

            <button
              type="button"
              onClick={handleConfirm}
              disabled={isProcessingCrop}
              className="flex items-center gap-1.5 px-4 py-2 bg-[#EA580C] hover:bg-[#c2410c] active:scale-95 text-white text-xs font-extrabold rounded-xl shadow-md transition disabled:opacity-50 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-200" />
              <span>{isProcessingCrop ? 'Đang cắt...' : 'Cắt & Bóc tách AI'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
