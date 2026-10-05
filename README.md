# usersync-web

אתר סטטי ליצירת קובצי LRC מסונכרנים בעזרת GitHub Actions.

## שימוש

פתח:
https://raw.githack.com/avtsye/usersync-web/main/docs/index.html

האתר מבקש Fine-grained GitHub PAT שמוגבל למאגר הזה בלבד, עם:
- Contents: Read and write
- Actions: Read and write

הטוקן אינו נשמר ב-localStorage ואינו נכתב למאגר.

## איך זה עובד

1. האתר יוצר Draft Release זמני.
2. קובץ השמע והטקסט עולים אליו כ-assets, ולא נכנסים ל-Git history.
3. GitHub Actions מפעיל faster-whisper על Linux CPU.
4. הטקסט שסופק מיושר מול חותמות הזמן של Whisper.
5. result.lrc נוסף ל-Draft Release.
6. קובצי המקור נמחקים אוטומטית מה-Release.
7. המשתמש מוריד את ה-LRC ויכול למחוק את העבודה הזמנית בלחיצה.

זהו MVP המבוסס על רעיון UserSync ומותאם ל-Web + GitHub Actions.
