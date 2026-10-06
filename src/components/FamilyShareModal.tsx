import React, { useState, useEffect } from 'react';
import { 
  X, Users, UserPlus, Shield, Trash2, ExternalLink, Loader2, 
  Mail, RefreshCw, Eye, Edit3, Crown, LogOut, ChevronDown
} from 'lucide-react';
import { 
  FamilyMember, 
  fetchFamilyMembers, 
  addFamilyMember, 
  updateFamilyMemberRole,
  removeFamilyMember, 
  SpreadsheetInfo,
  getKnownSpreadsheets,
  autoDiscoverSharedSpreadsheets
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
  const [roleInput, setRoleInput] = useState<'Editor' | 'Viewer'>('Viewer');
  const [updatingRoleEmail, setUpdatingRoleEmail] = useState<string | null>(null);
  const [isRemovingEmail, setIsRemovingEmail] = useState<string | null>(null);

  const resolveSheetId = async (): Promise<string | null> => {
    if (spreadsheetInfo?.id) return spreadsheetInfo.id;
    try {
      const token = await getAccessToken();
      if (!token) return null;
      const known = getKnownSpreadsheets();
      if (known.length > 0 && known[0].id) {
        return known[0].id;
      }
      const discovered = await autoDiscoverSharedSpreadsheets(token, currentUser?.email || '');
      if (discovered.length > 0 && discovered[0].id) {
        return discovered[0].id;
      }
    } catch {}
    return null;
  };

  const loadMembers = async () => {
    setIsLoading(true);
    try {
      const sheetId = await resolveSheetId();
      if (!sheetId) return;
      const token = await getAccessToken();
      if (!token) return;
      const list = await fetchFamilyMembers(token, sheetId);
      setMembers(list);
    } catch (err: any) {
      console.warn('[FamilyShare] Tải danh sách thành viên thất bại:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadMembers();
    }
  }, [isOpen, spreadsheetInfo?.id]);

  if (!isOpen) return null;

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    let email = emailInput.trim().toLowerCase();
    if (!email) {
      showToast('Vui lòng nhập email hoặc username!', 'warning');
      return;
    }
    
    // Tự động append @gmail.com nếu thiếu
    if (!email.includes('@')) {
      email = `${email}@gmail.com`;
    }

    const sheetId = await resolveSheetId();
    if (!sheetId) {
      showToast('Chưa có file Google Sheet liên kết.', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Chưa đăng nhập tài khoản Google.');

      await addFamilyMember(token, sheetId, email, roleInput);
      showToast(`✅ Đã cấp quyền ${roleInput === 'Editor' ? 'Được sửa' : 'Chỉ xem'} cho ${email}!`, 'success');
      setEmailInput('');
      await loadMembers();
    } catch (err: any) {
      showToast(`Lỗi cấp quyền: ${err.message || String(err)}`, 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggleRole = async (email: string, newRole: 'Editor' | 'Viewer') => {
    const sheetId = await resolveSheetId();
    if (!sheetId) return;
    setUpdatingRoleEmail(email);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Chưa đăng nhập tài khoản Google.');

      await updateFamilyMemberRole(token, sheetId, email, newRole);
      showToast(`Đã chuyển quyền của ${email} sang "${newRole === 'Editor' ? 'Được sửa' : 'Chỉ xem'}"!`, 'success');
      await loadMembers();
    } catch (err: any) {
      showToast(`Lỗi đổi quyền: ${err.message || String(err)}`, 'error');
    } finally {
      setUpdatingRoleEmail(null);
    }
  };

  const handleRemoveMember = async (email: string) => {
    const sheetId = await resolveSheetId();
    if (!sheetId) return;
    setIsRemovingEmail(email);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Chưa đăng nhập tài khoản Google.');

      await removeFamilyMember(token, sheetId, email);
      showToast(`Đã gỡ quyền truy cập của ${email}!`, 'success');
      await loadMembers();
    } catch (err: any) {
      showToast(`Lỗi gỡ quyền: ${err.message || String(err)}`, 'error');
    } finally {
      setIsRemovingEmail(null);
    }
  };

  const getInitials = (email: string, name?: string) => {
    if (name) return name.charAt(0).toUpperCase();
    return email.charAt(0).toUpperCase();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/60">
      <div 
        className="absolute inset-0 backdrop-blur-xs transition-opacity"
        onClick={onClose}
      />

      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-xl max-h-[92vh] sm:max-h-[96vh] flex flex-col overflow-hidden border border-slate-200">
        
        {/* Decoy input to trap browser autofill */}
        <input 
          type="text" 
          name="prevent_autofill" 
          id="prevent_autofill" 
          defaultValue="" 
          tabIndex={-1} 
          aria-hidden="true"
          className="hidden" 
          style={{ display: 'none', position: 'absolute', opacity: 0, pointerEvents: 'none' }} 
        />

        {/* Header - Dark Theme */}
        <div className="px-4 py-3 bg-[#0284C7] text-white flex items-center justify-between shrink-0 border-b border-sky-700">
          <div className="flex items-center gap-2.5">
            <Users className="w-5 h-5 text-emerald-300" />
            <h2 className="text-base font-extrabold text-white tracking-tight">
              Quản lý thành viên
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-sky-100/80 hover:text-white hover:bg-sky-600/60 transition cursor-pointer"
            aria-label="Đóng"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body - Light Theme (Scrollable inside) */}
        <div className="flex-1 overflow-y-auto p-2.5 space-y-2 bg-slate-50/60">
          
          {/* Block 1: Tài khoản hiện tại (Admin Card) */}
          <div className="p-2 bg-white rounded-xl border border-slate-200/90 shadow-3xs flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="text-xs text-slate-500 font-medium truncate block">
                Tài khoản: <strong className="text-slate-900 font-semibold">{currentUser?.email || 'Chưa đăng nhập'}</strong>
              </span>
            </div>
            <div className="flex items-center gap-1 px-2 py-0.5 bg-amber-100 text-amber-800 rounded-lg text-xs font-bold shrink-0 border border-amber-200 shadow-2xs">
              <span>👑 Admin</span>
            </div>
          </div>

          {/* Block 2: Thêm thành viên mới (Add Member Card) */}
          <form onSubmit={handleAddMember} autoComplete="off" className="bg-white p-2.5 rounded-xl border border-slate-200/90 shadow-3xs space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
              <UserPlus className="w-3.5 h-3.5 text-emerald-600" />
              <span>Thêm thành viên mới</span>
            </div>

            <div className="space-y-1.5">
              <div className="relative">
                <Mail className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  name="x_f2"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  readOnly
                  onFocus={(e) => e.target.removeAttribute('readonly')}
                  placeholder="Nhập tài khoản liên kết"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  className="w-full pl-8 pr-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-[#9e5628] focus:bg-white transition font-mono"
                  required
                />
              </div>
            </div>

            {/* Segmented Toggle Control */}
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setRoleInput('Viewer')}
                className={`h-8 px-3 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 border cursor-pointer ${
                  roleInput === 'Viewer'
                    ? 'bg-[#10B981] text-white border-[#10B981] shadow-xs'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span>👁️</span>
                <span>Chỉ xem</span>
              </button>

              <button
                type="button"
                onClick={() => setRoleInput('Editor')}
                className={`h-8 px-3 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 border cursor-pointer ${
                  roleInput === 'Editor'
                    ? 'bg-[#EA580C] text-white border-[#EA580C] shadow-xs'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span>✏️</span>
                <span>Được sửa</span>
              </button>
            </div>

            {/* Action Button */}
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full h-8.5 bg-[#EA580C] hover:bg-[#c2410c] disabled:opacity-50 text-white font-bold text-xs rounded-xl transition flex items-center justify-center gap-1.5 active:scale-95 shadow-xs cursor-pointer"
            >
              {isSubmitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <>
                  <UserPlus className="w-3.5 h-3.5 text-amber-200" />
                  <span>Thêm & Cấp quyền</span>
                </>
              )}
            </button>
          </form>

          {/* Block 3: Danh sách thành viên (Member List Card) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-bold text-slate-800 px-1">
              <div className="flex items-center gap-1.5">
                <Users className="w-4 h-4 text-emerald-600" />
                <span>Thành viên ({members.length})</span>
              </div>
              <button
                type="button"
                onClick={loadMembers}
                disabled={isLoading}
                className="text-slate-500 hover:text-slate-800 p-1 rounded-lg hover:bg-slate-100 transition flex items-center gap-1 text-[11px] cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
                <span>Làm mới</span>
              </button>
            </div>

            {isLoading ? (
              <div className="py-6 flex flex-col items-center justify-center text-slate-500 text-xs gap-2 bg-white rounded-2xl border border-slate-200">
                <Loader2 className="w-5 h-5 animate-spin text-[#9e5628]" />
                <span>Đang tải thành viên...</span>
              </div>
            ) : (() => {
              const otherMembers = members.filter(m => {
                const isOwner = m.role === 'Owner';
                const isSelf = currentUser?.email && m.email.toLowerCase() === currentUser.email.toLowerCase();
                return !isOwner && !isSelf;
              });

              return otherMembers.length === 0 ? (
                <div className="py-6 text-center text-slate-500 text-xs bg-white rounded-2xl border border-slate-200">
                  Chưa có thành viên nào khác được thêm.
                </div>
              ) : (
                <div className="space-y-2">
                  {otherMembers.map((m, idx) => {
                    const isOwner = m.role === 'Owner';
                    const isSelf = currentUser?.email && m.email.toLowerCase() === currentUser.email.toLowerCase();
                    const displayName = m.email.split('@')[0];

                  return (
                    <div
                      key={idx}
                      className="p-3 bg-white border border-slate-200/90 rounded-2xl flex items-center justify-between gap-3 shadow-3xs"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-amber-100 text-amber-900 font-black text-xs flex items-center justify-center border border-amber-200 shrink-0 shadow-2xs">
                          {getInitials(m.email, displayName)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-bold text-slate-900 truncate">
                              {displayName}
                            </span>
                            {isSelf && (
                              <span className="text-[10px] font-bold bg-slate-100 border border-slate-200 text-slate-600 px-1.5 py-0.5 rounded-md">
                                Bạn
                              </span>
                            )}
                          </div>
                          <span className="text-[11px] text-slate-500 truncate block font-mono">
                            {m.email}
                          </span>
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center gap-2">
                        {isOwner ? (
                          <div className="flex items-center gap-1 px-2.5 py-1 bg-amber-100 border border-amber-200 rounded-xl text-amber-800 text-xs font-bold shadow-2xs">
                            <span>👑 Admin</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={updatingRoleEmail === m.email || isRemovingEmail === m.email}
                              onClick={() => handleToggleRole(m.email, m.role === 'Editor' ? 'Viewer' : 'Editor')}
                              title={`Bấm để chuyển quyền sang "${m.role === 'Editor' ? 'Chỉ xem' : 'Được sửa'}"`}
                              className={`flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-bold border transition active:scale-95 cursor-pointer shadow-3xs disabled:opacity-50 ${
                                m.role === 'Editor'
                                  ? 'bg-amber-50 text-amber-900 border-amber-200 hover:bg-amber-100'
                                  : 'bg-emerald-50 text-emerald-900 border-emerald-200 hover:bg-emerald-100'
                              }`}
                            >
                              {updatingRoleEmail === m.email ? (
                                <Loader2 className="w-3 h-3 animate-spin text-slate-600" />
                              ) : (
                                <>
                                  <span>{m.role === 'Editor' ? '✏️ Sửa' : '👁️ Xem'}</span>
                                  <ChevronDown className="w-3 h-3 opacity-60" />
                                </>
                              )}
                            </button>

                            {!isSelf && (
                              <button
                                type="button"
                                disabled={!!isRemovingEmail || !!updatingRoleEmail}
                                onClick={() => handleRemoveMember(m.email)}
                                className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition active:scale-95 cursor-pointer disabled:opacity-50"
                                title="Xóa thành viên"
                              >
                                {isRemovingEmail === m.email ? (
                                  <Loader2 className="w-4 h-4 animate-spin text-rose-600" />
                                ) : (
                                  <Trash2 className="w-4 h-4" />
                                )}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          </div>
        </div>

        {/* Modal Footer (Unified bottom bar: Rời không gian & Đóng) */}
        <div className="px-4 py-3 bg-white border-t border-slate-200 flex items-center justify-between gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              showToast('Đang chuyển về kho sách cá nhân riêng...', 'info');
              onClose();
            }}
            className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl transition flex items-center gap-1.5 border border-slate-200 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5 text-slate-500" />
            <span>↳ Rời không gian</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 bg-slate-700 hover:bg-slate-800 text-white font-bold text-xs rounded-xl transition shadow-xs cursor-pointer"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};
