import React, { useState, useEffect } from 'react';
import { 
  X, Users, UserPlus, Shield, Trash2, ExternalLink, Loader2, 
  Mail, RefreshCw
} from 'lucide-react';
import { 
  FamilyMember, 
  fetchFamilyMembers, 
  addFamilyMember, 
  removeFamilyMember, 
  SpreadsheetInfo 
} from '../services/driveSyncService';
import { getAccessToken } from '../services/googleAuthService';
import { useToast } from '../context/ToastContext';
import { AuthUser } from '../types';

interface FamilyShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  spreadsheetInfo: SpreadsheetInfo | null;
  currentUser: AuthUser | null;
}

export const FamilyShareModal: React.FC<FamilyShareModalProps> = ({
  isOpen,
  onClose,
  spreadsheetInfo,
  currentUser,
}) => {
  const { showToast } = useToast();
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [roleInput, setRoleInput] = useState<'Editor' | 'Viewer'>('Editor');

  const loadMembers = async () => {
    if (!spreadsheetInfo?.id) return;
    setIsLoading(true);
    try {
      const token = await getAccessToken();
      if (!token) return;
      const list = await fetchFamilyMembers(token, spreadsheetInfo.id);
      setMembers(list);
    } catch (err: any) {
      console.warn('[FamilyShare] Tải danh sách thành viên thất bại:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && spreadsheetInfo?.id) {
      loadMembers();
    }
  }, [isOpen, spreadsheetInfo?.id]);

  if (!isOpen) return null;

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = emailInput.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      showToast('Vui lòng nhập địa chỉ Gmail hợp lệ!', 'warning');
      return;
    }

    if (!spreadsheetInfo?.id) {
      showToast('Chưa có file Google Sheet liên kết.', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Chưa đăng nhập tài khoản Google.');

      await addFamilyMember(token, spreadsheetInfo.id, email, roleInput);
      showToast(`✅ Đã cấp quyền ${roleInput === 'Editor' ? 'Chỉnh sửa' : 'Chỉ xem'} cho ${email}!`, 'success');
      setEmailInput('');
      await loadMembers();
    } catch (err: any) {
      showToast(`Lỗi cấp quyền: ${err.message || String(err)}`, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const [emailToRemoveConfirm, setEmailToRemoveConfirm] = useState<string | null>(null);

  const handleRemoveMember = async (email: string) => {
    if (!spreadsheetInfo?.id) return;

    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Chưa đăng nhập tài khoản Google.');

      await removeFamilyMember(token, spreadsheetInfo.id, email);
      showToast(`Đã gỡ quyền truy cập của ${email}!`, 'success');
      setEmailToRemoveConfirm(null);
      await loadMembers();
    } catch (err: any) {
      showToast(`Lỗi gỡ quyền: ${err.message || String(err)}`, 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div 
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-xs transition-opacity"
        onClick={onClose}
      />

      <div className="relative w-full max-w-lg bg-[#1c0e08] border border-[#452215] rounded-3xl p-5 sm:p-6 text-white shadow-2xl overflow-hidden flex flex-col space-y-4 max-h-[90vh]">
        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-amber-500 via-[#9e5628] to-amber-600" />

        {/* Header */}
        <div className="flex items-center justify-between pb-2 border-b border-[#452215]">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-[#9e5628] text-white shadow-xs">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-extrabold text-white">
                Chia Sẻ Tủ Sách Gia Đình
              </h2>
              <p className="text-xs text-amber-200/70">
                Cho phép người thân cùng truy cập và quản lý kho sách chung
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-amber-200/70 hover:text-white hover:bg-[#2b170e] rounded-xl transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Google Sheet Link Info */}
        {spreadsheetInfo && (
          <div className="p-3 bg-[#2b170e] rounded-2xl border border-[#452215] flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="text-[10px] text-amber-200/60 uppercase font-bold tracking-wider block">
                Google Sheet Đồng Bộ
              </span>
              <span className="text-xs font-bold text-white truncate block">
                {spreadsheetInfo.name || 'Kho Sách Cá Nhân'}
              </span>
            </div>
            {spreadsheetInfo.webViewLink && (
              <a
                href={spreadsheetInfo.webViewLink}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-xs text-amber-300 font-bold bg-[#1c0e08] px-2.5 py-1.5 rounded-xl border border-[#452215] shrink-0 transition hover:bg-[#381c12]"
              >
                <span>Mở Sheet</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        )}

        {/* Form Add Member */}
        <form onSubmit={handleAddMember} className="space-y-3 bg-[#2b170e]/80 p-3.5 rounded-2xl border border-[#452215]">
          <span className="text-xs font-bold text-amber-200 flex items-center gap-1.5">
            <UserPlus className="w-4 h-4 text-amber-400" />
            Thêm người thân vào tủ sách
          </span>

          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-lpignore="true"
                placeholder="Nhập địa chỉ Gmail..."
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                className="w-full pl-9 pr-3 py-2 bg-[#1c0e08] border border-[#452215] rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-[#9e5628]"
                required
              />
            </div>

            <select
              value={roleInput}
              onChange={(e) => setRoleInput(e.target.value as any)}
              className="bg-[#1c0e08] border border-[#452215] rounded-xl px-3 py-2 text-xs font-bold text-amber-200 focus:outline-none focus:border-[#9e5628]"
            >
              <option value="Editor">Chỉnh sửa</option>
              <option value="Viewer">Chỉ xem</option>
            </select>

            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 bg-[#9e5628] hover:bg-[#85451e] disabled:opacity-50 text-white font-bold text-xs rounded-xl transition flex items-center justify-center gap-1.5 shrink-0 active:scale-95 shadow-xs"
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  <UserPlus className="w-4 h-4" />
                  <span>Cấp Quyền</span>
                </>
              )}
            </button>
          </div>
        </form>

        {/* Members List */}
        <div className="space-y-2 flex-1 overflow-y-auto pr-1">
          <div className="flex items-center justify-between text-xs font-bold text-amber-200/80">
            <span>Danh sách thành viên ({members.length})</span>
            <button
              type="button"
              onClick={loadMembers}
              disabled={isLoading}
              className="text-amber-200/70 hover:text-white p-1 rounded-lg hover:bg-[#2b170e] transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {isLoading ? (
            <div className="py-6 flex flex-col items-center justify-center text-amber-200/70 text-xs gap-2">
              <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
              <span>Đang tải thành viên...</span>
            </div>
          ) : members.length === 0 ? (
            <div className="py-6 text-center text-amber-200/60 text-xs bg-[#2b170e]/50 rounded-2xl border border-[#452215]">
              Chưa có thành viên nào khác được thêm.
            </div>
          ) : (
            <div className="space-y-1.5">
              {members.map((m, idx) => {
                const isOwner = m.role === 'Owner';
                const isSelf = currentUser?.email && m.email.toLowerCase() === currentUser.email.toLowerCase();

                return (
                  <div
                    key={idx}
                    className="p-2.5 bg-[#2b170e] border border-[#452215] rounded-2xl flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={`p-1.5 rounded-xl text-xs font-bold ${
                        isOwner 
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : m.role === 'Editor'
                          ? 'bg-[#1b6b5b]/30 text-teal-300 border border-teal-500/30'
                          : 'bg-[#295588]/30 text-blue-300 border border-blue-500/30'
                      }`}>
                        <Shield className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <span className="text-xs font-bold text-white truncate block">
                          {m.email} {isSelf ? '(Bạn)' : ''}
                        </span>
                        <span className="text-[10px] text-amber-200/70 block">
                          Vai trò: <strong className="text-white">{m.role}</strong>
                        </span>
                      </div>
                    </div>

                    {!isOwner && !isSelf && (
                      <div className="shrink-0 flex items-center gap-1">
                        {emailToRemoveConfirm === m.email ? (
                          <div className="flex items-center gap-1 animate-in fade-in duration-100">
                            <button
                              type="button"
                              onClick={() => handleRemoveMember(m.email)}
                              className="px-2 py-1 bg-rose-600 hover:bg-rose-700 text-white font-bold text-[10px] rounded-lg transition active:scale-95 cursor-pointer shadow-3xs"
                            >
                              Gỡ
                            </button>
                            <button
                              type="button"
                              onClick={() => setEmailToRemoveConfirm(null)}
                              className="px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-200 font-bold text-[10px] rounded-lg transition active:scale-95 cursor-pointer"
                            >
                              Hủy
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setEmailToRemoveConfirm(m.email)}
                            className="p-1.5 text-amber-200/60 hover:text-rose-400 hover:bg-rose-500/10 rounded-xl transition"
                            title="Xóa quyền"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pt-2 border-t border-[#452215] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 bg-[#2b170e] hover:bg-[#381c12] text-amber-200 font-bold text-xs rounded-xl transition"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};
