## 1.1.0

- Recovery key of another PC can be entered – after a move, the old backups at the target can be read again. / Wiederherstellungs-Schlüssel eines anderen PCs eingebbar – nach einem Umzug lassen sich die alten Sicherungen am Ziel wieder lesen.
- Secrets out of rclone.conf and the process list: S3 keys, passwords and the encryption password are kept sealed and reach rclone only as environment variables (existing connections are moved over by themselves). / Geheimnisse raus aus rclone.conf und der Prozessliste: S3-Schlüssel, Passwörter und das Verschlüsselungs-Passwort bleiben versiegelt und erreichen rclone nur als Umgebungsvariablen (bestehende Verbindungen werden von selbst umgezogen).
- Backups at the target are listed on the page; the last runs (also failed ones) too. / Sicherungen am Ziel werden auf der Seite gezeigt, die letzten Läufe (auch fehlgeschlagene) ebenso.
- OneDrive Business and SharePoint libraries work (no longer forced to personal OneDrive). / OneDrive Business und SharePoint-Bibliotheken funktionieren (nicht mehr fest auf privates OneDrive).
- Sign-in without a screen: run “rclone authorize” on another PC and paste the result. / Anmeldung ohne Bildschirm: „rclone authorize“ auf einem anderen PC ausführen und das Ergebnis einfügen.
- Disconnecting handles errors; dates in Hostwerk’s language. / Trennen mit Fehlerbehandlung; Datum in Hostwerk-Sprache.
- Bandwidth limit (MB/s), optionally only in a time window. / Bandbreitengrenze (MB/s), auf Wunsch nur in einem Zeitfenster.
- Free space at the target after every test. / Freier Platz am Ziel nach jeder Prüfung.
- Service “cloudBackup” with the runs – the backup calendar shows them, failures included. / Dienst „cloudBackup“ mit den Läufen – der Sicherungs-Kalender zeigt sie, auch Fehlschläge.
- Error state with “Try again”, design scale, place in the sidebar under “System”, allowExtensions; release package contains everything except the repository tooling. / Fehlerzustand mit „Erneut versuchen“, Design-Skala, Platz in der Seitenleiste unter „System“, allowExtensions; Release-Paket enthält alles außer dem Repo-Werkzeug.

## 1.0.1

- Same symbol in the sidebar and in the page header (with Hostwerk 2.11 or newer). / Gleiches Symbol in der Seitenleiste und im Seitenkopf (ab Hostwerk 2.11).

## 1.0.0

- First release. / Erste Fassung.
