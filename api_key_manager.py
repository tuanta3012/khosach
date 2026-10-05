import time
import threading
import logging
from collections import deque
from typing import List, Dict, Any, Optional, Callable
from google import genai
from google.genai import types
from google.genai.errors import APIError

# Cấu hình logging để tiện theo dõi
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(threadName)s: %(message)s")
logger = logging.getLogger("APIKeyManager")

class GeminiKey:
    """
    Lớp đại diện cho một API Key và trạng thái của nó
    """
    def __init__(self, key: str, rpm_limit: int = 14, rpd_limit: int = 500):
        self.key = key
        self.rpm_limit = rpm_limit
        self.rpd_limit = rpd_limit
        
        # Khóa độc quyền cho key này
        self.lock = threading.Lock()
        
        # Sliding Window Rate Limiter cho RPM
        self.call_history = deque()
        
        # Bộ đếm cuộc gọi trong ngày (RPD)
        self.daily_count = 0
        self.last_reset_day = time.strftime("%Y-%m-%d")
        self.disabled_daily = False
        
        # Exponential Backoff cho lỗi 429
        self.cooldown_until = 0.0
        self.backoff_factor = 0  # Số lần lỗi liên tiếp (dùng để nhân số mũ)
        
    def is_available(self) -> bool:
        """
        Kiểm tra Key có sẵn sàng sử dụng hay không (không bị cooldown và không bị cạn RPD)
        """
        now = time.time()
        today = time.strftime("%Y-%m-%d")
        
        # Tự động reset bộ đếm ngày mới
        if today != self.last_reset_day:
            self.daily_count = 0
            self.last_reset_day = today
            self.disabled_daily = False
            
        if self.disabled_daily:
            return False
            
        if now < self.cooldown_until:
            return False
            
        return True

    def acquire_rpm_slot(self, window_seconds: int = 60):
        """
        Đảm bảo tuân thủ Sliding Window Rate Limiter (RPM).
        Nếu chạm trần RPM, tự động trì hoãn (time.sleep) cho đến khi có slot trống.
        """
        while True:
            now = time.time()
            
            # Làm sạch các mốc thời gian cũ ngoài cửa sổ trượt
            while self.call_history and (now - self.call_history[0] > window_seconds):
                self.call_history.popleft()
                
            if len(self.call_history) < self.rpm_limit:
                # Vẫn còn slot trống
                self.call_history.append(now)
                self.daily_count += 1
                if self.daily_count >= self.rpd_limit:
                    self.disabled_daily = True
                    logger.warning(f"Key {self.key[:6]}... đã đạt hạn mức ngày {self.rpd_limit} RPD. Đã vô hiệu hóa trong hôm nay.")
                break
            else:
                # Đã chạm trần RPM, tính toán thời gian chờ vừa đủ
                oldest_call = self.call_history[0]
                wait_time = window_seconds - (now - oldest_call) + 0.1  # Thêm biên an toàn 100ms
                if wait_time > 0:
                    logger.warning(f"Key {self.key[:6]}... chạm trần {self.rpm_limit} RPM. Tự động ngủ trong {wait_time:.2f}s...")
                    time.sleep(wait_time)

    def trigger_cooldown(self, initial_wait: int = 10):
        """
        Kích hoạt Cooldown tăng dần (Exponential Backoff) khi gặp lỗi 429
        """
        self.backoff_factor += 1
        wait_seconds = initial_wait * (2 ** (self.backoff_factor - 1))
        self.cooldown_until = time.time() + wait_seconds
        logger.error(f"Key {self.key[:6]}... gặp lỗi Rate Limit. Kích hoạt Cooldown {wait_seconds}s (Backoff lần {self.backoff_factor}).")

    def reset_backoff(self):
        """
        Reset trạng thái backoff khi cuộc gọi thành công
        """
        self.backoff_factor = 0
        self.cooldown_until = 0.0


class APIKeyManager:
    """
    Lớp điều phối gọi Gemini API đa luồng, xoay vòng nhiều Keys và Models,
    quản lý hạn ngạch an toàn tuyệt đối và tự động khôi phục lỗi (Failover).
    """
    def __init__(self, api_keys: List[str], models: List[str] = None):
        if not api_keys:
            raise ValueError("Danh sách API Keys không được trống.")
            
        self.keys = [GeminiKey(k) for k in api_keys]
        self.models = models or ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
        
        # Chỉ số xoay vòng Round-Robin và Khóa an toàn đa luồng
        self.rr_index = 0
        self.rr_lock = threading.Lock()

    def _get_next_available_key(self) -> GeminiKey:
        """
        Xoay vòng Round-Robin để tìm kiếm và trả về Key sẵn sàng tiếp theo.
        Nếu tất cả các Keys đều bận/cooldown, sẽ ném ra lỗi hoặc ngủ chờ.
        """
        with self.rr_lock:
            num_keys = len(self.keys)
            for _ in range(num_keys):
                candidate = self.keys[self.rr_index]
                self.rr_index = (self.rr_index + 1) % num_keys
                if candidate.is_available():
                    return candidate
            
            # Thử tìm key có thời gian cooldown kết thúc sớm nhất để ngủ chờ ngắn
            active_cooldowns = [k for k in self.keys if not k.disabled_daily]
            if active_cooldowns:
                earliest_key = min(active_cooldowns, key=lambda k: k.cooldown_until)
                wait_seconds = max(0.5, earliest_key.cooldown_until - time.time())
                logger.warning(f"Tất cả các Keys đều đang cooldown hoặc cạn kiệt. Tự động chờ {wait_seconds:.2f}s cho Key rảnh sớm nhất...")
                time.sleep(wait_seconds)
                return earliest_key
                
            raise RuntimeError("Toàn bộ các API Keys đã cạn kiệt hạn ngạch ngày RPD. Không thể thực hiện thêm cuộc gọi nào hôm nay!")

    def generate_content(self, prompt_builder: Callable[[], str], model_index: int = 0) -> str:
        """
        Thực hiện cuộc gọi Gemini sinh nội dung với cơ chế xoay vòng Key và Failover tự động.
        
        :param prompt_builder: Hàm callback tạo prompt (được gọi động ngay trước khi request để lấy nội dung mới nhất)
        :param model_index: Chỉ số model ưu tiên trong danh sách MODELS
        :return: Chuỗi văn bản kết quả sinh ra từ Gemini
        """
        if model_index >= len(self.models):
            model_index = 0
            
        model = self.models[model_index]
        gemini_key = self._get_next_available_key()
        
        # Khóa độc quyền Key này trong suốt quá trình chuẩn bị RPM slot và gọi API để tránh xung đột đa luồng
        with gemini_key.lock:
            # Tuân thủ hạn ngạch RPM
            gemini_key.acquire_rpm_slot()
            
            try:
                # Khởi tạo client mới bằng thư viện chính thức google.genai
                client = genai.Client(api_key=gemini_key.key)
                prompt = prompt_builder()
                
                logger.info(f"Đang gọi model '{model}' sử dụng Key {gemini_key.key[:6]}...")
                response = client.models.generate_content(
                    model=model,
                    contents=prompt
                )
                
                # 1. Kiểm tra bộ lọc an toàn hoặc từ chối sinh nội dung từ Google
                if response.candidates and len(response.candidates) > 0:
                    candidate = response.candidates[0]
                    finish_reason = getattr(candidate, 'finish_reason', None) or getattr(candidate, 'finishReason', None)
                    if finish_reason and finish_reason not in ['STOP', 'MAX_TOKENS', 1, 2]: # STOP=1, MAX_TOKENS=2
                        raise ValueError(f"Yêu cầu bị từ chối bởi Google AI (Finish Reason: {finish_reason}).")
                        
                # 2. Kiểm tra prompt feedback block
                prompt_feedback = getattr(response, 'prompt_feedback', None) or getattr(response, 'promptFeedback', None)
                if prompt_feedback:
                    block_reason = getattr(prompt_feedback, 'block_reason', None) or getattr(prompt_feedback, 'blockReason', None)
                    if block_reason:
                        raise ValueError(f"Nội dung bị chặn bởi bộ lọc an toàn Google AI (Block Reason: {block_reason}).")

                # Cuộc gọi thành công -> Reset trạng thái lỗi cooldown
                gemini_key.reset_backoff()
                return response.text or ""
                
            except APIError as api_err:
                err_msg = str(api_err).lower()
                logger.error(f"Lỗi API từ Google: {api_err}")
                
                # Kiểm tra lỗi hết hạn mức ngày RPD
                if any(kw in err_msg for kw in ['daily', 'per_day', 'perday', 'free_tier_daily_limit', '500 requests']):
                    gemini_key.disabled_daily = True
                    logger.error(f"Key {gemini_key.key[:6]}... báo lỗi hết hạn mức ngày. Chuyển sang Key tiếp theo...")
                    # Failover lập tức sang Key khác với cùng model
                    return self.generate_content(prompt_builder, model_index)
                    
                # Kiểm tra lỗi hết RPM / Tần suất (429 / 503)
                elif any(kw in err_msg for kw in ['429', '503', 'quota', 'resource_exhausted', 'rate limit', 'too many requests']):
                    gemini_key.trigger_cooldown()
                    # Thử lại bằng Key khác
                    return self.generate_content(prompt_builder, model_index)
                
                else:
                    # Các lỗi API khác (ví dụ: lỗi cấu hình model,...) -> Chuyển sang model dự phòng tiếp theo
                    logger.warning(f"Lỗi không xác định. Tiến hành dự phòng sang Model tiếp theo...")
                    next_model_idx = (model_index + 1) % len(self.models)
                    return self.generate_content(prompt_builder, next_model_idx)
                    
            except Exception as e:
                # Lỗi không phải từ API Google -> Ném ngoại lệ hoặc ghi log
                logger.error(f"Lỗi hệ thống ngoài dự kiến: {e}")
                raise e


# ==========================================
# ĐOẠN CODE CHẠY THỬ NGHIỆM ĐA LUỒNG (TEST)
# ==========================================
if __name__ == "__main__":
    # Thay thế các chuỗi dưới đây bằng API Keys thực tế của bạn
    TEST_KEYS = [
        "AIzaSyFakeKeyA_1234567890",
        "AIzaSyFakeKeyB_0987654321",
        "AIzaSyFakeKeyC_abcdefghij"
    ]
    
    # Khởi tạo lớp điều phối với 3 Keys và thứ tự ưu tiên 3.5 Flash Lite trước
    manager = APIKeyManager(
        api_keys=TEST_KEYS,
        models=["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
    )
    
    def worker_task(thread_id: int):
        """
        Nhiệm vụ giả lập chạy song song trên nhiều luồng
        """
        def build_my_prompt():
            return f"Hãy kể một câu chuyện cười ngắn về lập trình viên, luồng số {thread_id}."
            
        try:
            result = manager.generate_content(build_my_prompt)
            print(f"\n[Thread {thread_id} THÀNH CÔNG]\nKết quả: {result[:120]}...\n")
        except Exception as e:
            print(f"\n[Thread {thread_id} THẤT BẠI] Lỗi: {e}\n")

    # Kích hoạt 10 luồng chạy song song để kiểm tra an toàn đa luồng (Thread-Safety)
    threads = []
    print("=== BẮT ĐẦU CHẠY THỬ NGHIỆM ĐA LUỒNG ===")
    for i in range(10):
        t = threading.Thread(target=worker_task, args=(i,), name=f"Worker-{i}")
        threads.append(t)
        t.start()
        
    for t in threads:
        t.join()
        
    print("=== HOÀN TẤT THỬ NGHIỆM ĐA LUỒNG ===")
