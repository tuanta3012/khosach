import fs from 'fs';

const rawData = `Tên sách,Tác giả,Thể loại
1941 - Những khám phá mới về Châu Mỹ thời kỳ tiền Columbus,Charles Mann,
21 bài học cho thế kỷ 21,Yuval Noah Harari,
3 lần và 7 lần,Chu Lai,
3 phút sơ cứu,Ngô Đức Hùng,
40 năm văn học nghệ thuật TP HCM,Nhiều tác giả ,
80 ngày vòng quanh thế giới ,Jules Verne ,
Ác mộng,Hải Lăng,Tiểu thuyết
After you,Jojo Moyes,
An hưởng tuổi vàng,BS. Nguyễn Ý Đức,
"Ăn, cầu nguyện, yêu",Elizabeth Gilbert,
Anh chàng Hobbit,J.R.R. Tolkien,Văn học giả tưởng
Anh có thích nước Mỹ không?,Tân Di Ổ,Văn học Trung Quốc
Anh Em Nhà Himmler,Katrin Himmler,
Ánh sáng trắng,Jon Fosse,Văn học nước ngoài
Anna Karenina - tập 1,Lev Tolstoy,
Anna Karenina - tập 2,Lev Tolstoy,
Anne tóc đỏ dưới chái nhà xanh,L.M. Montgomery,Văn học thiếu nhi
Ảo ảnh của thanh xuân,Inui Kurumi,
Atlas giải phẫu cơ thể người ,Alice Roberts,
B.Trọc,Phạm Viết Long,
Bà Bovary ,Gustave Flaubert ,
Ba người khác ,Tô Hoài,
Ba người lính ngự lâm - tập 1,Alexandr Dumas,
Ba người lính ngự lâm - tập 2,Alexander Dumas ,
Bá tước Dracula ,Bram Stoker,
Bá tước Monte Cristo,Alexandre Dumas,
Bà Vua,Pearl Buck,
Bác Hana,Alena Mornštajnová,Văn học nước ngoài
Bác sĩ Zhivago,Boris Pasternak,
Bạch dạ hành,Higashino Keigo,
Bách khoa thư về khoa học ,Định Tị Books,
Bạch Mã,Đỗ Quyên,Tuyển chọn & Dịch
Bản Chất Của Người,Han Kang,
Bàn có năm chỗ ngồi ,Nguyễn Nhật Ánh ,
Bạn đang nghịch gì với đời mình?,J. Krishnamurti,Triết học / Tâm lý
Bảo Đại - Vị vua triểu Nguyễn cuối cùng,Phan Hữu Lang,
Bắt Trẻ Đồng Xanh,J.D. Salinger,
Bảy bước tới mùa hè ,Nguyễn Nhật Ánh ,
Bầy cừu xuất chúng,William Deresiewicz,Giáo dục / Tư duy
Bay trên tổ chim cúc cu ,Ken Kesey,
Bay vòng quanh mặt trăng,Jules Verne,Khoa học viễn tưởng
Bè trầm ,Bảo Ninh - Nguyễn Quang Lập - Trung Trung Đỉnh,
Ben Hur,Lewis Wallace ,
Bến không chồng ,Dương Hướng,
Bên nhau trọn đời,Cố Mạn,
Bến trần gian,(Nhiều tác giả),
Bệnh học,Lê Thị Luyến ,
Bí đầu ra,Atsushi Nakajima,
Bí mật của nước ,Masaru Emoto,
Bí mật thành Paris - tập 1,Eugene Sue,
Bí mật thành Paris - tập 2,Eugene Sue,
Bí mật thành Paris - tập 3,Eugene Sue,
Bí mật thành Paris - tập 4,Eugene Sue,
Bí mật thành Paris - tập 5,Eugene Sue,
Bí mật tối thượng ,Dan Brown,
Bí quyết hội họa - luyện vẽ hình khối ,Từ Hảo,
Bí quyết hội họa vẽ tranh phong cảnh,Từ Hảo,
Biên bản chiến tranh 1-2-3-4.75,Trần Mai Hạnh,Tư liệu lịch sử
Biên niên ký chim vặn dây cót,Haruki Murakami,Văn học Nhật Bản
Biên niên sử Thế giới từ tiền sử đến 1945,Nguyễn Văn Đàn,
Biệt động Sài Gòn ,Nguyễn Đức Hùng (Tư Chu),
Bồ câu chung mái vòm,Dương Thụy,
Bố già ,Mario Puzo,
Bố mìn Mẹ mìn,Tô Hoài,
Bốn mươi năm nói láo,Vũ Bằng,
Bốn năm sau,Nguyễn Huy Tưởng,
Bong bóng lên trời ,Nguyễn Nhật Ánh ,
Bông hồng vàng và bình minh mưa,K. G. Paustovsky,
Bông sen vàng,Sơn Tùng ,
Bức thư của người đàn bà không quen,Stefan Zweig,Tiểu thuyết lãng mạn
Búp bê Bắc Kinh ,Xuân Thụ,
Búp sen xanh,Sơn Tùng,Tiểu thuyết về Bác Hồ
Cà phê đợi một người ,Cửu Bả Đao,
Các cuộc chiến tranh tiền tệ ,James Rickards,
Các nền văn minh cổ đại ,Francoise Perrudin,
Các thế giới song song ,Michio Kaku,
Các triều đại Việt Nam ,Quỳnh Cư - Vũ Đức Hùng,
Cafe cùng Tony,Tony buổi sáng ,
Cái đầu của giáo sư Dowel,Alexander Belyaev,Khoa học viễn tưởng
Cẩm nang con trai,Violeta Babic,Kỹ năng cho trẻ
Cẩm nang sử dụng và mua sắm đồ trang sức vàng bạc đã quý,Phan Tòng Phúc,
Cánh buồm đỏ thắm,Aleksandr Grin,
Cánh đồng bất tận ,Nguyễn Ngọc Tư,
Carmen,Proxpe Merime,
Cây cam ngọt của tôi,Jose Mauro Vasconcekolos,
Cây chuối non đi đôi giày xanh,Nguyễn Nhật Ánh ,
Cha con Giáo hoàng,Mario Puzo,
Chân dung và đối thoại ,Trần Đăng Khoa,
Chân trần chí thép ,James Junwatt,
Chạng vạng ,Stephenie Meyer,
Chiến binh cầu vồng,Andrea Hirata,
Chiến tranh không có một khuôn mặt phụ nữ,Svetlana Alexievich,
Chiến tranh và hòa bình - tập 1,Lev Tolstoy,
Chiến tranh và hòa bình - tập 2,Lev Tolstoy,
Chinh phục tiếng Nhật (Sách nằm ngang),(Nhiều tác giả),
Cho tôi xin một vé đi tuổi thơ ,Nguyễn Nhật Ánh ,
Chữ A màu đỏ,Nathaniel Hawthorne,Văn học kinh điển
Chú bé mang Pyjama sọc,John Boyne,
Chú bé rắc rối ,Nguyễn Nhật Ánh ,
Chúa Ruồi,William Golding,
Chúa tể những chiếc nhẫn - Đoàn hộ nhẫn,Tolkien,
Chúa tể những chiếc nhẫn - Hai tòa tháp,Tolkien,
Chúa tể những chiếc nhẫn - Nhà vua trở về ,Tolkien,
Chúc một ngày tốt lành ,Nguyễn Nhật Ánh ,
Chùm nho phẫn nộ,John Steinbeck,
Chúng Tôi Đã Sống Như Thế,Nguyễn Ánh Tuyết,
Chúng tôi thời hậu chiến,Vũ Công Chiến,Hồi ký
Chuông nguyện hồn ai,Ernest Hemingway,
Chuyện con mèo dạy hải âu bay,Luis Sepulveda,
Chuyện đời đại sứ,Nguyễn Thị Ngọc Hải ,
Chuyện làng Cuội,Lê Lựu,
Chuyện phiêu lưu của Mít đặc và các bạn ,Nicolai Noxop,
Cô bé hàng xóm và bốn viên kẹo,Nguyễn Nhật Ánh ,
Cô đơn trên mạng ,Janus Leon Wisniewski,
Cô gái đến từ hôm qua ,Nguyễn Nhật Ánh ,
Cô gái năm ấy chúng ta cùng theo đuổi ,Cửu Bả Đao,
Cổ học tinh hoa ,Ôn Như Nguyễn Văn Ngọc,
Cơ hội của Chúa,Nguyễn Việt Hà,
Cỗ máy thời gian ,H.G.Wells,
"Có một ngày, bố mẹ sẽ già đi",Nhiều tác giả,Tản văn / Gia đình
Cocktail the Bible,Linda Doeser,
Columbus và 4 chuyến hải hành,Laurence Bergreen,
Cơm áo xứ người - Viết về nước Mỹ,Nhiều tác giả ,
Con Bim trắng tai đen,Gavriil Troyepolsky,Văn học Nga
Con chó nhỏ mang giỏ hoa hồng ,Nguyễn Nhật Ánh ,
Con đường đói khổ,Ben Okri,
Con đường Hồi giáo ,Nguyễn Phương Mai,
Con hủi,Helena Mniszek,
Cơn sốt lúc Bình Minh ,Gardos Peter,
Cộng hòa,Plato,
Của chuột và người,John Steinbeck,Văn học kinh điển
Cung đường vàng nắng,Dương Thụy,
Cuộc chiến tranh bắt buộc ,Nguyễn Văn Hồng,
Cuộc đời của Pi,Yann Martel,
Cuộc đối đầu không cân sức ,Phan Thu,
Cuộc phiêu lưu của Pinocchio ,Carlo Collodi,
Cuộc phiêu lưu của thuyền trưởng Corcoran,Alfred Assollant,Văn học phiêu lưu
Cuộc phiêu lưu cuối cùng của Feynman,Ralph Leighton,
Cuộc Phiêu Lưu Kỳ Diệu Của Nils Holgersson,Selma Lagerlöf,
Cuộc phiêu lưu kỳ lạ của Karik và Valia,Yan Larri,
Cuộc thách đấu ,Guy De Maupassant,
Cuốn theo chiều gió tập 1 - bản dịch Vũ Kim Thư,Magaret Mitchell ,
Cuốn theo chiều gió tập 2 - bản dịch Vũ Kim Thư,Magaret Mitchell ,
Đại Việt Sử ký toàn thư,Ngô Sỹ Liên ,
Đàn hương hình,Mạc Ngôn,
Đặng Thùy Trâm và chiến trường Đức Phổ ,Lê Thành Giai,
Đặng Tiểu Bình - Một trí tuệ siêu việt,(Nhiều tác giả),
Đảo chìm,Trần Đăng Khoa,
Đảo giấu vàng,Robert Louis Stevenson,
Đảo Mộng mơ ,Nguyễn Nhật Ánh ,
Đất dữ,Jorge Amado,
Đất lành (A House Divided),Pearl S. Buck,Văn học kinh điển
Đất máu Sicily ,Mario Puzo,
Đất rừng phương Nam,Đoàn Giỏi,Văn học thiếu nhi Việt Nam
Đất trời vần vũ ,Nguyễn Một,
Đất và người ,Đào Sỹ Quang,
Đệ nhất phu nhân Trần Lệ Xuân,Hoàng Trọng Miên,Tiểu thuyết lịch sử
Đế quốc An Nam và người dân An Nam,Jules Silvestre,
Đề Thám - Thời kỳ huy hoàng ,Maliverney,
Đêm định mệnh của tàu Titanic ,Walter Lord,
Đèn không hắt bóng ,Watanabe Dzunichi,
Đi ngang Hà Nội,Nguyễn Ngọc Tiến,Văn hóa / Khảo cứu
Đi tìm bà ngoại,Walter Macken,Văn học thiếu nhi
Đi tìm ý nghĩa cuộc sống ,Ernie Carwile,
Đi trốn,Bình Ca,Tiểu thuyết
Dịch hạch ,Albert Camus,
Điên cuồng như Vệ Tuệ,Vệ Tuệ,
Điều Kỳ Diệu Của Tiệm Tạp Hóa Namiya,Higashino Keigo,
Định luật Murphy,Từ Thính Phong,
Đọc hiểu kết quả xét nghiệm máu để sống lâu và khỏe mạnh ,James Lavalle,
Đọc Lolita ở Tehran,Azar Nafisi,
Đời con (The Good Earth),Pearl S. Buck,Văn học kinh điển
Đội gạo lên chùa,Nguyễn Xuân Khánh,
Đồi gió hú,Emily Brontë,Văn học kinh điển
Động phòng hoa chúc cách vách,Diệp Lạc Vô Tâm,
Đợt tuyệt chủng thứ sáu,Elizabeth Kolbert,Khoa học / Môi trường
Drawing Nature for the Absolute Beginner,Mark and Mary Willenbrink,
Dự án kế hoạch kinh doanh từ ý tưởng đến VB hoàn chỉnh ,Đỗ Minh Cường,
Đứa con gái hoang đàng,Jeffrey Archer,
Đừng chết ở Ả Rập Xê Út ,Nghiêm Hương,
Em phải đến Harvard học kinh tế ,Lưu Vệ Hoa - Trương Hân Vũ,
Em sẽ đến cùng cơn mưa ,Ichikawa Takuji,
Forrest Gump,Winston Groom,
Frankenstein ,Mary Shelley,
Gai Hướng Dương ,Nozomi Katsura,
Gấm rách,Phỉ Ngã Tư Tồn,
Gatsby vĩ đại,F. Scott Fitzgerald,Văn học kinh điển
Giấc mơ Mỹ - Đường đến Stanford ,Huyền Chip,
Giải nghĩa các câu thành ngữ Việt Nam ,Viện Văn học,
Giàn thiêu,Võ Thị Hảo,
Giáo dục não phải,Makoto Shichida,Giáo dục trẻ em
Giết con chim nhại,Harper Lee,
Gió lẻ và 9 câu chuyện khác,Nguyễn Ngọc Tư,Văn học đương đại
Gió lốc - phóng sự chiến tranh - 3,Báo QĐND,
Gió qua rặng liễu,Kenneth Graham e,
Grey,E. L. James,
Hạ đỏ,Nguyễn Nhật Ánh ,
Hà nội trong cơn gió lốc,Vũ Bằng ,
Hachiko chú chó đợi chờ,Luis Prats,
Hai số phận,Jeffrey Archer,
Hai vạn dặm dưới biển ,Jules Verne ,
Hành lý hư vô,Nguyễn Ngọc Tư,Tản văn Việt Nam
Hành trình về phương Đông ,Nguyên Phong,
Hảo hán nơi trảng cát,Jorge Amado,Văn học nước ngoài
Harry Potter và bảo bối tử thần - 7,J.K.Rowling ,
Harry Potter và chiếc cốc lửa - 4,J.K.Rowling ,
Harry Potter và đứa trẻ bị nguyền rủa - 8,J.K.Rowling ,
Harry Potter Và hoàng tử lai - 6,J.K.Rowling ,
Harry Potter và Hội phượng hoàng - 5,J.K.Rowling ,
Harry Potter và Hòn đá phù thủy -1,J.K.Rowling ,
Harry Potter và Phòng chứa Bí mật -2,J.K.Rowling ,
Harry Potter và tên tù nhân ngục Azkaban - 3,J.K.Rowling ,
Hãy chăm sóc mẹ,Shin Kyung Sook,
Hệ miễn dịch - Kiệt tác của sự sống,Cao Bảo Anh,Khoa học sức khỏe
Heidi,Johanna Spyai,
Hét Lên Trong Cơn Mưa Phùn,Dư Hoa,
Hiệp sĩ Don Quixote ,Miguel De Cervantes Saavedra,
Hiệu ảnh Nishimura ở Enoshima,Mikami En,
Hiệu sách cuối cùng ở London,Madeline Martin,
Hoa hồng xứ khác ,Nguyễn Nhật Ánh ,
Hỏa ngục ,Dan Brown,
Hoa sen xanh (Tập 1),Chương Xuân Di,
Hoa sen xanh (Tập 2),Chương Xuân Di,
Hoa tulip đen,Alexandre Dumas,Tiểu thuyết kinh điển
Hoa vàng cố hương,Lưu Chân Vân,
Hỏa xa ngầm,Colson Whitehead,
Hoàng tử bé ,Antoine De Saint Exupery,
Học kiểu Mỹ tại nhà,Hồng Đinh,Giáo dục
Hồi ký tướng lưu vong Hoành Linh Đỗ Mậu,Đỗ Mậu,
Hồi ức của một Geisha,Arthur Golden,
Hồi ức lính,Vũ Công Chiến,Hồi ký chiến tranh
Homo Deus - Lược sử tương lai ,Yuval Noah Harari,
Hồng Lâu Mộng - tập 1,Tào Tuyết Cần,
Hồng Lâu Mộng - tập 2,Tào Tuyết Cần,
Hồng Lâu Mộng - tập 3,Tào Tuyết Cần,
Hồng Lâu Mộng - tập 4,Tào Tuyết Cần,
Hướng dẫn đầu tư vàng và bạc,Michael Maloney ,
Huynh đệ,Dư Hoa,
I am Malala,Malala Yousafzai,
Ivanhoe,Walter Scott,
Jamila - Truyện núi đồi và thảo nguyên,Chingiz Aitmatov,Văn học nước ngoài
Jane Eyre,Charlotte Bronte ,
Kafka bên bờ biển,Haruki Murakami,Văn học Nhật Bản
Kẻ chăn dắt ,Đặng Chương Ngạn,
Kể chuyện Thành ngữ - Tục ngữ,(Nhiều tác giả),
Kẻ dọn rác,Tấn Minh,Tiểu thuyết
Kẹo bạc hà cho tình đầu,Nhiều tác giả,Tập truyện
Khát vọng ,Nguyễn Thị Thanh,
Khi hơi thở hóa thinh không,Paul Kalanithi,Tự truyện
Khoán chui hay là chết,Thái Duy,
Khỏe vì sinh tố mạnh nhờ khoáng tố,Lương Lễ Hoàng,
Khơi sáng tinh thần & giải tỏa stress,Mike George,
Không diệt không sinh đừng sợ hãi,Thích Nhất Hạnh,Phật giáo / Tâm linh
Không gia đình,Hector Malot,Văn học thiếu nhi
Không phụ như lai không phụ nàng (Tập 1),Chương Xuân Di,
Không phụ như lai không phụ nàng (Tập 2),Chương Xuân Di,
Không quên,Nguyễn Đông Thức,
Không thể chuộc lỗi ,Allen Hassan,
Khu vườn bí mật ,Frances Hodgson Burnette,
Khuôn Mặt Người Khác,Kobo Abe,
Kim Bình Mai - tập 1,Tiếu Tiểu Sinh ,
Kim Bình Mai - tập 2,Tiếu Tiểu Sinh ,
Kim Các Tự ,Mishima Jukio,
Kinh Dịch - Đạo của người quân tử ,Nguyễn Hiến Lê ,Triết học / Cổ học
Kinh tế học dành cho đại chúng,Steven E. Landsburg,
Kinh tụng thời trang,Baek Young Ok,
Kính vạn hoa 1-18,Nguyễn Nhật Ánh ,
Kỳ án pháp y - 1,Lục Ngoạn,
Kỳ án pháp y - 2,Lục Ngoạn,
Ký sự chiến tranh ,Nhiều tác giả ,
Kỹ thuật xoa bóp và bấm huyệt bàn chân,(Nhiều tác giả),Y học thường thức
Lá nằm trong lá,Nguyễn Nhật Ánh ,
Làm bạn với bầu trời ,Nguyễn Nhật Ánh ,
Làm sạch mạch và máu,Nishi Katsuzo,Sức khỏe
Lâu đài cổ D'Eppstein,Alexandre Dumas,
Lệ đường,Thomas Joiner,Tâm lý học
Lê Văn Thảo tuyển tập,,
Lê Vân yêu và sống ,Lê Vân,
Lên lớp không được đọc tiểu thuyết ,Cửu Bả Đao ,
Lịch sử Gestapo ,Jacques Delarue,
Lịch sử nước Việt bằng tranh  ,,
Lịch sử sư đoàn 316,Bộ Tư lệnh quân khu 2,
Lịch sử Thượng đế,Karen Armstrong ,
Lịch sử vạn vật,Bill Bryson,
Lịch sử vương quốc đàng ngoài ,Alexandre De Rhodes,
Liêu trai chí dị - tập 1,Bồ Tùng Linh,
Liêu trai chí dị - tập 2,Bồ Tùng Linh,
Lời nguyện cầu cho những linh hồn phiêu bạt ,Đoàn Tuấn,
Lolita,Vladimir Nabokov,
Lớn lên trên đảo vắng ,Johann David Wyss,
Lũ trẻ đường ray,E. Nesbit,Văn học thiếu nhi
Luật im lặng ,Mario Puzo,
Lực lượng mãnh hổ - tội ác 1967 ở miền Trung VN,Michael Sallah- Mitch Weiss,
Lược sử khoa học,William Bynum,Kiến thức tổng quát
Lưu thông máu tốt hóa giải bách bệnh,Akiyoshi Horie,Y học thường thức
Ly tán (Sons),Pearl S. Buck,Văn học kinh điển
Lý thuyết trò chơi,Trần Phách Hàm,Kỹ năng / Tư duy
Mãi mãi một thời thiếu sinh quân,Ma Văn Kháng,Hồi ký / Văn học
Mãi Mãi Tuổi Hai Mươi,Nguyễn Văn Thạc,
Marketing Hệ não đồ ,David Lewis,
Mắt biếc,Nguyễn Nhật Ánh ,
Mặt của đàn ông,Nguyễn Việt Hà,
Mẫu thượng ngàn,Nguyễn Xuân Khánh,
Mẹ mìn bố mìn,Tô Hoài,
Miễn dịch học ,ĐH Y HN,
Miếng ăn nhà người ,Henri Troyat,
Miếng da lừa ,Honore De Balzac,
Miếng ngon Hà Nội ,Vũ Bằng,
Minh triết trong ăn uống của phương Đông,Ngô Đức Vượng,
Mình và Họ,Nguyễn Bình Phương,Văn học đương đại
Mô hình lấy bệnh nhân làm trung tâm ,Charles Kenney,
Mọi nơi vụn vỡ (phần 2 Chú bé mang Pyjama sọc),John Boyne,
Một chiến dịch ở Bắc Kỳ ,Hocquard,
Một chuyện đời,Shogo Sato,
Một lít nước mắt,Kito Aya,
Mưa Đỏ,Chu Lai,
Mùa hè không tên ,Nguyễn Nhật Ánh ,
Mùa lá rụng trong vườn ,Ma Văn Kháng,
Mùi Của Ký Ức,Nguyễn Quang Thiều,
Mùi hoài vọng,Ario Morisawa,Văn học Nhật Bản
Mười người da đen nhỏ,Agatha Christie,
Muối trăm năm,Mường Mán,
Muôn kiếp nhân sinh (Tập 1),Nguyên Phong,Tâm linh / Triết học
Muôn kiếp nhân sinh (Tập 2),Nguyên Phong,Tâm linh / Triết học
Nam Phương hoàng hậu cuối cùng triều Nguyễn ,Lý Nhân,
Năm tháng nhọc nhằn năm tháng nhớ thương,Ma Văn Kháng,Hồi ký
Nanh trắng,Jack London,Văn học kinh điển
Ngàn mặt trời rực rỡ,Khaled Hosseini,
Ngày tháng năm,Diêm Liên Khoa,Văn học Trung Quốc
Ngày trong sương mù ,Hà Nhân,
Ngày xưa có một chuyện tình ,Nguyễn Nhật Ánh ,
Ngày xưa có một con bò,Camilo Cruz,Kỹ năng sống (Self-help)
Nghĩ giàu và làm giàu,Napoleon Hill,
Nghìn lẻ một ngày,Francoise Petis De La Croix,
Ngỡ đã là yêu,Yasmina Khadra,
Ngoại ô,Nguyễn Đình Lạp,
Ngồi khóc trên cây,Nguyễn Nhật Ánh ,
Ngôi trường mọi khi ,Nguyễn Nhật Ánh ,
Ngồi tù khám lớn,Phan Văn Hùm,
Ngọn đèn không tắt ,Nguyễn Ngọc Tư,
Ngủ ít vẫn khỏe,Satoru Tsubota,
Ngụ ngôn Edop,Edop,
Ngựa ô yêu dấu,Anna Sewell,Văn học kinh điển
Ngược Mặt Trời ,Nguyễn Một,
Người Ăn Chay,Han Kang,
Người đàn bà nghịch cát,Nguyễn Đăng An,Tiểu thuyết
Người đàn ông mang tên Ove,Fredrik Backman,Văn học đương đại
Người đua diều ,Khaled Hosseini,
Người Mỹ Trầm Lặng,Graham Greene,
Người sống sót,Tấn Minh,Tiểu thuyết
Người và cảnh Hà Nội ,Hoàng Đạo Thúy ,
Nguồn cội ,Dan Brown,
Nguyễn Bính - Thơ và Đời,Hoàng Xuân,
Nhà giả kim,Paulo Coelho,Tiểu thuyết kinh điển
Nhà tù Côn Đảo 1862-1945,Nguyễn Linh,
Nhàn đàm y học,Khoa Nguyễn Văn Tuấn,
Nhân tố Enzyme - Minh họa,Hiromi Shinya,Sức
Nhân tố Enzyme - Phương pháp sống lành mạnh,Hiromi Shinya,Sức khỏe / Đời sống
Nhân tố Enzyme - Thực hành,Hiromi Shinya,Sức khỏe / Đời sống
Nhân tố Enzyme - Trẻ hóa,Hiromi Shinya,Sức khỏe / Đời sống
Nhân trường hợp của chị Thỏ Bông,Thảo Hảo,
Nhật ký 300 ngày ở Harvard,Trương Phạm Hoài Chung,
Nhật Ký Anne Frank,Anne Frank,
Nhật ký bị lãng quên ,Shizukui Shusuke,
Nhật ký chiến trường ,Dương Thị Xuân Quý,
Nhật ký chiến trường ,Nguyễn Tiến Bình,
Nhật ký Đặng Thùy Trâm,Đặng Thùy Trâm,Nhật ký chiến tranh
Nhật ký học làm bánh,Linh Trang,
Nhật ký làm bánh,Linh Trang,
Nhật ký tiểu thư Jones,Helen Fielding,
Nhớ - hồi ký Phạm Duy ,Phạm Duy,
Như núi như mây,Nguyễn Đông Thức,
Những câu hỏi lớn Tiến hóa ,Francisco Ayala,
Những cây thuốc và vị thuốc Việt Nam ,Đỗ Tất Lợi,
Những Chàng Trai xấu tính ,Nguyễn Nhật Ánh ,
Những cô em gái ,Nguyễn Nhật Ánh ,
Những con chim ẩn mình chờ chết,Colleen McCullough,Văn học kinh điển
Những giấc mơ ở hiệu sách Morisaki 1,Yagisawa Satoshi,Văn học Nhật Bản
Những giấc mơ ở hiệu sách Morisaki 2,Yagisawa Satoshi,Văn học Nhật Bản
Những giấc mơ từ cha tôi,Barack Obama,
Những gương mặt,(Nhiều tác giả),
Những khám phá mới về Châu Mỹ Thời kỳ Tiền Columbus,Charles C. Mann,Lịch sử / Khám phá
Những lá thư không gửi (Ngân Hà dịch),Suise Morgenstern ,
Những mảnh đời được ban tặng  - chiến dịch không vận trẻ em 1975,Dana Sachs,
Những ngày bão táp,Hữu Mai,
Những ngày thơ ấu ,Nguyên Hồng,
Những người đẹp say ngủ,Kawabata Yasunari,
Những người khốn khổ - tập 1,Victor Hugo,
Những người khốn khổ - tập 2,Victor Hugo,
Những người khốn khổ - tập 3,Victor Hugo,
Những Người Phụ Nữ Bé Nhỏ,Louisa May Alcott,
Những người sống mãi ,Thép Mới,
Những người thích đùa,Azit Nexin,Văn học trào phúng (Thổ Nhĩ Kỳ)
Những tấm ảnh trở về,Liệt sỹ Nguyễn Văn Giá,
Những tấm lòng cao cả,Edmondo De Amicis,Văn học thiếu nhi / Giáo dục
Những tháng ngày đẹp nhất ,Ban công tác phụ nữ quân đội ,
Những trang viết trong thời lửa đạn ,NXB Hội nhà văn ,
Nữ sinh ,Nguyễn Nhật Ánh ,
"Nước Mỹ, Người Mỹ và tôi",Nhiều tác giả,
Ở Xứ Tự Do,V.S. Naipaul,
Ông già Khốttabit tập 1+2,Lagin,
Ông già và biển cả,Ernest Hemingway,Văn học kinh điển
Ông trăm tuổi trèo qua cửa sổ và biến mất ,Jonas Jonasson,
Ông trùm cuối cùng ,Mario Puzo,
Ông Tướng Tình Báo ,Hoàng Hải Vân & Tấn Tú,
Oxford thương yêu ,Dương Thụy ,
P.S I love you ,Cecelia Ahern,
Papillon Người tù khổ sai,Henri Charriere,
Phải sống (bản tiếng Trung),Dư Hoa,
Phạm Xuân Ẩn - Tên người như cuộc đời,Nguyễn Thị Ngọc Hải,Hồi ký / Lịch sử
Phía Đông vườn Địa Đàng,John Steinbeck,Văn học kinh điển
Phía Sau Nghi Can X,Higashino Keigo,
Phía Tây không có gì lạ ,Erich Maria Remarque ,
Phố,Chu Lai,
Phong trào Duy Tân ở Bắc Trung Nam - Miền nam đầu thế kỷ 20 - Thiên địa hội & cuộc minh tân,Sơn Nam,Lịch sử - Văn hóa Nam Bộ
Phóng viên chiến trường,Trần Mai Hưởng,Hồi ký / Lịch sử
Phục sinh,Lev Tolstoy,
Phương Đông lướt ngoài cửa sổ ,Paul Theroux,
Phương pháp ăn uống cải thiện lưu thông máu,Akiyoshi Horie,Y học thường thức
Quân khu Nam Đồng ,Bình Ca,
Quân vương,Niccolò Machiavelli,Chính trị / Triết học
Quẳng gánh lo đi và vui sống,Dale Carnegie,Tâm lý / Kỹ năng
Quê hương địa đạo ,Viễn Phương,
Quê nội,Võ Quảng,Văn học Việt Nam
Quo Vadis,Henryk Sienkiewics,
Quỷ cái vận đồ Prada,Lauren Weisberger,
Quyền lực bà Rồng,,
Ra bờ suối ngắm hoa kèn hổng ,Nguyễn Nhật Ánh ,
Rạch mặt,Đỗ Quyên,
Rập rờn cánh hạc,Kawabata Yasunari,
Robinson Crusoe,Daniel Defoe,Văn học kinh điển
Rừng Na-uy,Haruki Murakami,
Ruồi trâu ,Ethel Voynich,
Sapiens Lược sử loài người ,Yaval Noah Harari,
Sáu ngày của Thần Ưng,James Grady,Tiểu thuyết trinh thám
SBC là săn bắt chuột,Hồ Anh Thái,
Sherlock Holmes (Tập 2 )- NXB Văn Học,Conan Doyle,Trinh thám
Sherlock Home tập 2 - NXB CAND,,
Siêu giàu (Crazy Rich Asians) - tập 1,Kevin Kwan,
Số phận không định trước,Nguyễn Khắc Phê,
Socrates in love,Katayama Kyoichi,
Sông,Nguyễn Ngọc Tư ,
Sống ( Phải sống),Dư Hoa,
Sông Đông êm đềm,Sholokhov,
Sống như mình thích,Nguyễn Hiến Lê,
Sống ở đáy sông,Lê Lựu,Văn học Việt Nam
Sống theo sở thích ,Nguyễn Hiến Lê,
Sự hình thành thế giới ,Bertrand Fichou,
Sự im lặng của bầy cừu ,Thomas Harris,
Sử ký Tư Mã Thiên,Nguyễn Hiến Lê ,
Sự sụp đổ của nghề làm cha mẹ ,Leonard Sax,
Sự trỗi dậy và suy tàn của đế chế thứ 3,William Shirer,
Súng vi trùng và thép,Jared Diamond,
Suối nguồn,Ayn Rand,
Tại sao phương Tây vượt trội? ,Ian Morris,
Tâm lý học dân tộc An Nam ,Paul Giran,
Tam quốc diễn nghĩa - tập 1,La Quán Trung ,
Tam quốc diễn nghĩa - tập 2,La Quán Trung ,
Tam quốc diễn nghĩa - tập 3,La Quán Trung ,
Tàn Ngày Để Lại,Kazuo Ishiguro,
Tất cả các dòng sông đều chảy,Nancy Cato,Tiểu thuyết kinh điển
Tắt đèn,Ngô Tất Tố,Văn học hiện thực
Tàu tốc hành,Hac Murakami,Văn học Nhật Bản
Tây Du Ký tập 1,Ngô Thừa Ân,
Tây Du Ký tập 2,Ngô Thừa Ân,
Tây Du Ký tập 3,Ngô Thừa Ân,
Tể tướng Lưu Gù,Ân Văn Thạc,
Tết ở làng Địa ngục ,Thảo Trang,
Thần số học ứng dụng,Joy Woodward,Tâm lý / Kỹ năng
Thần thoại Bắc Âu ,Neil Gaiman,
Thần thoại Hy Lạp ,Nguyễn Văn Khỏa,
Thánh Kinh - Tân Ước ,Phó Hằng Cơ,
Thánh kinh dưỡng da,Chizu Saeki,Chăm sóc sức khỏe & sắc đẹp
Thành phố Hồ Chí Minh - Giờ khác số 0,Borries Gallasch,Lịch sử / Ghi chép
Thao thức ,Alexsandr Kron,
Thay đổi cuộc sống với Nhân số học,Lê Đỗ Quỳnh Hương (phóng tác),Tâm lý / Kỹ năng
Thầy thuốc gia đình ,Tony Smith,
Thế giới quả là rộng lớn và có nhiều việc phải làm,Kim Woo Choong,Kinh doanh / Truyền cảm hứng
The Quiet American (Bản tiếng Anh),Graham Greene,
The story of a watch company,Tissot,Lịch sử thương hiệu
Thép đã tôi thế đấy ,Nikolai A Ostrovsky,
Thép đã tôi thế đấy ,Nikolai Osteovsky,
Thi nhân Việt Nam,Hoài Thanh - Hoài Chân,Phê bình văn học
Thiên tài và sự giáo dục từ sớm,Kimura Kyuichi,Giáo dục trẻ em
Thiên thần nhỏ của tôi ,Nguyễn Nhật Ánh ,
Thiên thần và ác quỷ ,Dan Brown,
Thơ Và Đời,Nguyễn Bính,
Thợ xăm ở Auschwitz,Heather Morris,
Thời thơ ấu - trong thế giới - những trường Đại học của tôi ,Maxim Gorky ,
Thời xa vắng,Lê Lựu,
Thông điệp của nước ,Masaru Emoto,
Thư gửi từ Miền Điện,Aung San Suu Kyi,Chính trị / Văn học
Thư pháp Trung Hòa dành cho người Việt Nam ,Phan Thế Phiệt,
Thuật tẩy não trong giáo dục,Takafumi Horie,Tư duy / Giáo dục
Thương Nhớ Mười Hai,Vũ Bằng,
Thuyền trưởng tuổi 15,Jules Verne,
Thuyết phục ,Jane Austen,
Tiệm quan tài số 7 - tập 1,Niệm Tiểu Duệ,
Tiệm sách của nàng ,Nguyễn Nhật Ánh ,
Tiền bạc và lý trí,Dan Ariely & Jeff Kreisler,Kinh tế học hành vi
Tiếng gọi của hoang dã,Jack London,Văn học kinh điển
Tiếng Vọng Đèo Khau Chỉa,Nguyễn Thái Long,
Tội ác và hình phạt,Fyodor Dostoevsky,Văn học kinh điển Nga
Tôi đã thấy hoa vàng trên cỏ xanh ,Nguyễn Nhật Ánh ,
Tôi đi học,Nguyễn Ngọc Ký,Hồi ký nghị lực sống
Tôi đi làm osin ở Mỹ,Huỳnh Yên Trầm My,
Tôi là Beto,Nguyễn Nhật Ánh ,
"Tôi, Charley và hành trình nước Mỹ ",John Steinbeck,
Tổng hành dinh trong mùa xuân toàn thắng ,Võ Nguyên Giáp ,
Tottochan bên cửa sổ ,Tetsuko,
Tottochan bên cửa sổ - truyện viết tiếp ,Tetsuko,
Trăm năm cô đơn ,Gabriel Garcia Marquez,
Trần Lệ Xuân giấc mộng chính trường ,Lý Nhân,
Trần Quốc Toản,Lưu Sơn Minh,Tiểu thuyết lịch sử
Trắng,Han Kang,
Trên đường băng,Tony buổi sáng ,
Trên sa mạc và trong rừng thẳm,Henryk Sienkiewicz,Văn học thiếu nhi
Triệu phú bán rong (Tập 1),Jeffrey Archer,
Triệu phú bán rong (Tập 2),Jeffrey Archer,
Triệu phú khu ổ chuột,Vikas Swarup,
Trở về Eden,Rosalind Miles,
Trọn đời bên nhau,Mặc Bảo Phi Bảo,
Trong cơn gió lốc ,Khuất Quang Thụy,
Trong gia đình,Hector Malot,Văn học thiếu nhi
Trước ngày em đến - tiếng Việt,,
Trước vòng chung kết ,Nguyễn Nhật Ánh ,
Truyện cổ Andersen ,Andersen ,
Truyện cổ Grimm tập 1,Anh em Grimm,
Truyện cổ Grimm tập 2,Anh em Grimm,
Truyện cổ Grimm tập 3,Anh em Grimm,
Truyện cổ Grimm tập 4,Anh em Grimm,
Truyện Kiều,Nguyễn Du,Văn học cổ điển Việt Nam
Truyện ngắn Châu Phi ,NXB Văn học,
Truyện ngắn Chu Lai,Chu Lai,
Truyện ngắn đặc sắc về Hà Nội từ 1986 đến nay,Nhiều tác giả,Tuyển tập văn học
Truyện ngắn Nguyễn Minh Châu,Nguyễn Minh Châu,Văn học Việt Nam
Truyện Tây Bắc,Tô Hoài,Văn học Việt Nam
Từ điển bách khoa Brittannica,NXB Giáo dục ,
Tư duy như Leonardo Da Vinci,Michael J. Gelb,
Tự học đông y,Bùi Huy,
Từ sông Bến Hải đến dinh Độc Lập,(Nhiều tác giả),
Tự thú của một tín đồ shopping,Sophie Kinsella,Văn học giải trí
Từ Trái Đất đến mặt trăng ,Jules Verne,
Tự truyện của mãnh hổ đường số 9,Nguyễn Khắc Nguyệt,
Tự truyện của một cán bộ tình báo ,Nguyễn Nho Quý,
Tuổi Thơ Dữ Dội (Tập 1 & 2),Phùng Quán,
Tuổi thơ im lặng ,Duy Khán,
Tướng Cao Văn Khánh (Hồi ức lịch sử),Nguyễn Hy Vọng - Cao Anh Minh,Lịch sử / Hồi ký
Tướng về hưu & những chuyện khác ,Nguyễn Huy Thiệp,
Túp lều bác Tom,Harriet Beecher Stowe,
Tuyển tập Kim Lân,Kim Lân,Văn học hiện thực
Tuyển tập Nam Cao,Nam Cao,Văn học hiện thực
Tuyển tập Nguyễn Công Hoan,Nguyễn Công Hoan,Văn học trào phúng
Tuyển tập Nguyên Hồng,Nguyễn Hồng,Văn học hiện thực
Tuyển tập Nguyễn Tuân (Quyển 1),Nguyễn Tuân,
Tuyển tập Nguyễn Tuân (Quyển 2),Nguyễn Tuân,
Tuyển tập Nguyễn Tuân (Quyển 3),Nguyễn Tuân,
Tuyển tập Nhất Linh - Khải Hưng,Nhất Linh - Khải Hưng,Văn học (Tự lực văn đoàn)
Tuyển tập O' Henry,O' Henry,Văn học nước ngoài
Tuyển tập Thạch Lam,Thạch Lam,Văn học lãng mạn (Tự lực văn đoàn)
Tuyển tập truyện ngắn Lỗ Tấn,Lỗ Tấn,
Tuyển tập Vũ Trọng Phụng,Vũ Trọng Phụng,Văn học hiện thực
Tuyệt không dấu vết ,Nguyễn Việt Hà,
Utopia (Địa đàng trần gian),Thomas More,
Văn minh phương Đông và Tây phương,Thu Giang Nguyễn Duy Cần,Triết học / Văn hóa
Văn thi sĩ tiền chiến,Nguyễn Vỹ,
Văn thơ tiền chiến,Nguyễn Vy,
Vạn vật thực hành như thế nào,David Macaulay ,
Vang bóng một thời ,Nguyễn Tuân ,
Vị tu sĩ bán chiếc Ferrari,Robin Sharma,Phát triển bản thân
Việt Nam sử lược ,Trần Trọng Kim,
"Vô cùng tàn nhẫn, Vô cùng yêu thương",Sara Imas,
"Vợ ơi, theo anh về nhà",Tôn Tiểu Thất,
Vũ Trọng Phụng Toàn tập (Quyển 1),Vũ Trọng Phụng,
Vũ Trọng Phụng Toàn tập (Quyển 3),Vũ Trọng Phụng,
Vũ Trọng Phụng Toàn tập (Quyển 4),Vũ Trọng Phụng,
Vũ trụ ,Carl Sagan,
Vừa nhắm mắt vừa mở cửa sổ ,Nguyễn Ngọc Thuận,
Vùng trời - tập 1,Hữu Mai,
Vùng trời - tập 2,Hữu Mai,
Vượt Côn Đảo ,Phùng Quán ,
X30 phá lưới ,Đặng Thanh,
X6 - Điệp viên hoàn hảo ,Larry Berman,
Xách ba lô lên và đi - tập 1,Huyền Chip,
Xách ba lô lên và đi - tập 2,Huyền Chip ,
Xoa Bóp Huyệt Vị,Đông A Sáng,
Xứ Đông Dương ,Paul Doumer,
Xứ tuyết ,Kawabata Yasunari,
Xuân Lộc,Hoàng Đình Quang,
Xuyên Mỹ ,Phan Việt ,
Yêu người ngóng núi ,Nguyễn Ngọc Tư ,`;

function parseCSV(text: string) {
  const lines = text.trim().split('\n');
  const results: any[] = [];
  
  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Parse CSV line handling quotes
    let title = '';
    let author = '';
    let category = '';
    
    let inQuotes = false;
    let currentField = '';
    const fields: string[] = [];
    
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(currentField.trim());
        currentField = '';
      } else {
        currentField += char;
      }
    }
    fields.push(currentField.trim());
    
    title = (fields[0] || '').replace(/^"|"$/g, '').trim();
    author = (fields[1] || '').replace(/^"|"$/g, '').trim();
    category = (fields[2] || '').replace(/^"|"$/g, '').trim();
    
    if (title) {
      results.push({
        id: 'book_' + (i).toString().padStart(4, '0'),
        title: title,
        author: author || 'Khuyết danh',
        publisher: '',
        category: category || 'Chung',
        created_at: Date.now() - (lines.length - i) * 1000,
        updated_at: Date.now() - (lines.length - i) * 1000,
      });
    }
  }
  return results;
}

const parsedBooks = parseCSV(rawData);
console.log(`Parsed ${parsedBooks.length} books.`);

const outputTS = `/**
 * Bộ dữ liệu danh mục gốc của người dùng (~${parsedBooks.length} cuốn sách)
 * 100% dữ liệu chuẩn chỉ gồm: Tên sách, Tác giả, Thể loại, NXB
 */

import { BookRecord } from '../types';

export const USER_MASTER_BOOKS: BookRecord[] = ${JSON.stringify(parsedBooks, null, 2)};
`;

fs.writeFileSync('src/data/sampleBooks.ts', outputTS, 'utf-8');
console.log('Successfully wrote src/data/sampleBooks.ts');
