# Entropic Spotify
**本專案已棄用**
> [!IMPORTANT]
> 本專案是我在使用Spotify Premium期間製作的API工具，目前已經到期，因此停止維護。有需要的任何人可以直接複製整個儲存庫，上傳至自己的GitHub，然後到Spotify開發者工具申請API（需要Premium），將開發者頁面中的網址替換為自己的儲存庫連結，再將儲存庫內的API金鑰換成自己的，即可以使用此工具。

作者資訊：[離線企鵝](https://linktr.ee/penguin.offline)

## 如何使用此儲存庫
Spotify在2026年中更改了原本相對開放的Web API工具政策，現在只有Spotify Premium用戶能開發API，且一般的獨立開發者僅能讓5位測試者使用，僅有大型商用專案才能公開，這基本上扼殺了一切新創API，如果你擁有Spotify Premium並想要使用此API工具，步驟如下：
1. 新建自己的GitHub儲存庫並開啟網頁功能
2. 將本儲存庫中的所有內容複製到自己的儲存庫
3. 搜尋並開啟「Spotify for Developers Web API」
4. 申請Web API，在網址填入自己儲存庫對應網頁的index.html和last.html網址
5. 打開自己儲存庫的index.js和last.js，將Web API給出的Clint ID換成自己的
6. 將這兩個檔案中的redirectUri也換成自己對應網頁的網址
7. 打開自己的index.html，登入後即可使用
若要將網站分享給朋友，請向朋友要他們的Spotify使用者名稱和註冊的電子郵件（朋友不需要有Spotify Premium），接著在API開發者介面的「User Management」填入朋友的資訊，他們就能使用這個網站了，最多可以有5位自己外的朋友使用。

## index.html 功能

## last.html 功能
