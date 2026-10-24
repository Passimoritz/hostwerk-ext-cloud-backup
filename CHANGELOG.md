## 1.5.1

- New animated icon and banner in the common Hostwerk style (isometric block). / Neues animiertes Symbol und Banner im gemeinsamen Hostwerk-Stil (isometrischer Block).

## 1.5.0

- Fits on one screen: finished steps become one line with a tick and a short summary (“Change” opens them again), only the next open step is unfolded – you see at once what is missing / Passt auf einen Bildschirm: erledigte Schritte werden eine Zeile mit Häkchen und kurzer Zusammenfassung („Ändern“ klappt sie wieder auf), offen ist nur der nächste Schritt – man sieht sofort, was fehlt

## 1.4.0

- Lives where it belongs: Backups → Cloud backup – no own sidebar entry any more (Hostwerk 3.0+); the full page stays under Extensions → Open and can be pinned in the sidebar settings. / Steckt jetzt dort, wo sie hingehört: Sicherungen → Cloud-Sicherung – kein eigener Seitenleisten-Eintrag mehr (Hostwerk 3.0+); die ganze Seite bleibt unter Erweiterungen → Öffnen und lässt sich in den Seitenleisten-Einstellungen anheften.

## 1.3.0

- The very first connection always failed: since 1.1 the encryption password only reaches rclone as environment variable, but the test right after connecting ran before it was stored ("password not set in config file"). The test now gets the new secrets. / Die allererste Verbindung schlug immer fehl: seit 1.1 erreicht das Verschlüsselungs-Passwort rclone nur als Umgebungsvariable, der Test direkt nach dem Verbinden lief aber, bevor es gespeichert war („password not set in config file“). Der Test bekommt die neuen Geheimnisse jetzt mit.
- S3 with a wrong key: instead of rclone's "is a file not a directory" the real reason (SignatureDoesNotMatch …). Errors of the external backup in Hostwerk's language. / S3 mit falschem Schlüssel: statt „is a file not a directory“ der echte Grund; Fehler der externen Sicherung in Hostwerks Sprache.
- OneDrive: "rclone config create --non-interactive" stopped at the question "Token already configured – replace it?", so drive_id and drive_type were never set and every backup failed. The setup now answers rclone's questions one by one (also Google Drive's "keep the shared client ID?"). / OneDrive: „rclone config create --non-interactive“ blieb bei der Frage „Token schon eingerichtet – ersetzen?“ stehen, drive_id und drive_type fehlten, jede Sicherung schlug fehl. Die Einrichtung beantwortet die Rückfragen von rclone jetzt nacheinander (auch Google Drives „gemeinsame Client-ID weiter nutzen?“).
- Own app registration (client ID + secret) for Google Drive and OneDrive – the secret only as environment variable, sealed by Hostwerk. / Eigene App-Registrierung (Client-ID + Geheimnis) für Google Drive und OneDrive – das Geheimnis nur als Umgebungsvariable, von Hostwerk versiegelt.
- Readable messages for an expired or withdrawn sign-in, a full target, rejected S3 keys, a wrong password and an unreachable target (rclone's line stays as detail). / Verständliche Meldungen bei abgelaufener oder entzogener Anmeldung, vollem Ziel, abgelehnten S3-Schlüsseln, falschem Passwort und nicht erreichbarem Ziel (die rclone-Zeile bleibt als Detail).

## 1.2.0

- Only changes (Hostwerk 3.0 and newer): unchanged files of the external backup are copied at the target instead of uploaded again, and old backups that newer ones still point to are kept. / Nur Änderungen (ab Hostwerk 3.0): unveränderte Dateien der externen Sicherung werden am Ziel kopiert statt erneut hochgeladen; alte Stände, auf die neuere noch verweisen, bleiben erhalten.

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
