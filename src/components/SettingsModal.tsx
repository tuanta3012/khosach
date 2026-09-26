import React, { useState } from 'react';
import { X, Settings as SettingsIcon, Tag, Plus, Trash2, Check, RefreshCw, ArrowUpCircle } from 'lucide-react';
import { LibrarySettings } from '../types';
import { useToast } from '../context/ToastContext';
import { CURRENT_APP_VERSION } from '../version';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: LibrarySettings;
  onSaveSettings: (newSettings: LibrarySettings) => Promise<void>;
  onResetMasterData?: () => Promise<void>;
  onCheckUpdates?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSaveSettings,
  onResetMasterData,
  onCheckUpdates,
}) => {
  const { showToast } = useToast();
  const [categories, setCategories] = useState<string[]>(settings.categoriesList || []);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  if (!isOpen) return null;

  const handleAddCategory = () => {
    if (!newCategoryInput.trim()) return;
    if (categories.includes(newCategoryInput.trim())) {
      showToast('Thể loại này đã tồn tại!', 'info');
      return;
    }
    setCategories([...categories, newCategoryInput.trim()]);
    setNewCategoryInput('');
  };

  const handleRemoveCategory = (cat: string) => {
    setCategories(categories.filter((c) => c !== cat));
  };

  const handleSaveAll = async () => {
    setIsSaving(true);
    try {
      await onSaveSettings({
        ...settings,
        categoriesList: categories,
      });
      showToast('Đã lưu cấu hình kho sách thành công!', 'success');
      onClose();
    } catch (err: any) {
      showToast(`Lỗi khi lưu cài đặt: ${err.message}`, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetData = async () => {
    if (!onResetMasterData) return;
    if (window.confirm('Khôi phục toàn bộ 591 cuốn sách gốc từ file và xóa sạch dữ liệu trùng lặp/mẫu cũ?')) {
      try {
        setIsResetting(true);
        await onResetMasterData();
        showToast('Đã nạp 591 cuốn sách gốc thành công!', 'success');
        onClose();
      } catch {
        showToast('Lỗi khi nạp dữ liệu', 'error');
      } finally {
        setIsResetting(false);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-lg w-full shadow-2xl border border-slate-100 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-slate-200 text-slate-700 flex items-center justify-center">
              <SettingsIcon className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">Cấu Hình Kho Sách</h3>
              <p className="text-xs text-slate-500">Quản lý danh mục thể loại và dữ liệu gốc</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {/* Quản lý danh sách Thể loại */}
          <div className="space-y-2">
            <label className="block text-xs font-bold text-slate-700">
              Danh mục Thể loại sách
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={newCategoryInput}
                onChange={(e) => setNewCategoryInput(e.target.value)}
                placeholder="Thêm thể loại mới (e.g. Văn học, Kinh tế, Lịch sử...)"
                className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
                onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
              />
              <button
                onClick={handleAddCategory}
                className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold flex items-center gap-1 transition"
              >
                <Plus className="w-4 h-4" />
                <span>Thêm</span>
              </button>
            </div>

            <div className="flex flex-wrap gap-1.5 pt-1 max-h-40 overflow-y-auto">
              {categories.map((cat) => (
                <span
                  key={cat}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 text-slate-800 text-xs font-semibold rounded-lg border border-slate-200"
                >
                  <Tag className="w-3 h-3 text-slate-500" />
                  <span>{cat}</span>
                  <button
                    onClick={() => handleRemoveCategory(cat)}
                    className="ml-1 text-slate-400 hover:text-rose-600"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* Quản lý cập nhật phiên bản */}
          <div className="pt-4 border-t border-slate-100">
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex items-center justify-between gap-3">
              <div>
                <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                  <ArrowUpCircle className="w-4 h-4 text-emerald-600" />
                  Phiên bản ứng dụng
                </span>
                <span className="text-xs text-slate-500 block mt-0.5">
                  Bản cài đặt hiện tại: <strong className="text-slate-700">v{CURRENT_APP_VERSION}</strong>
                </span>
              </div>
              {onCheckUpdates && (
                <button
                  type="button"
                  onClick={onCheckUpdates}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl transition shadow-xs"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Kiểm tra cập nhật</span>
                </button>
              )}
            </div>
          </div>

          {/* Nạp lại dữ liệu gốc */}
          {onResetMasterData && (
            <div className="pt-4 border-t border-slate-100">
              <div className="p-4 bg-amber-50 rounded-2xl border border-amber-200 flex flex-col gap-2">
                <span className="text-xs font-bold text-amber-900">Dữ liệu danh mục gốc (591 cuốn)</span>
                <span className="text-xs text-amber-700">
                  Nạp lại toàn bộ 591 cuốn sách chuẩn của bạn vào Firestore và loại bỏ dữ liệu mẫu.
                </span>
                <button
                  type="button"
                  onClick={handleResetData}
                  disabled={isResetting}
                  className="mt-1 self-start flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl transition shadow-xs disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isResetting ? 'animate-spin' : ''}`} />
                  <span>Nạp Lại Dữ Liệu Gốc Vào Firestore</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200/60 rounded-xl transition"
          >
            Đóng
          </button>
          <button
            onClick={handleSaveAll}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-xs transition disabled:opacity-50"
          >
            <Check className="w-4 h-4" />
            <span>Lưu Cấu Hình</span>
          </button>
        </div>
      </div>
    </div>
  );
};
