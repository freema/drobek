# drobek: návrh

**Open-source platforma, kde tvůj vlastní AI agent (Claude, Cursor, Codex…) staví malé webové appky přímo u nás na serveru a my je hned hostujeme.** Něco jako Claude artifacts, jen s vlastní adresou, databází a přihlašováním.

## Jak to funguje

1. Připojíš drobek do svého AI asistenta.
2. Řekneš mu, co chceš, třeba „udělej mi rezervační formulář pro kadeřnictví“.
3. Agent appku napíše rovnou u nás, sám si opraví chyby a pošle ti náhled.
4. Jedním pokynem appku zveřejníš na vlastní adrese.

Nic neinstaluješ, nic neřešíš s hostingem.

## Co dostaneš

- Hosting appek s historií verzí a okamžitým náhledem.
- Hotové stavební bloky: přihlašování, databáze, formuláře, e-maily, soubory a napojení na cizí služby.
- Přehledný panel pro správu appek, dat a domén.

## Proč je to jiné

- **Open source a na vlastním serveru.** Firma si to nainstaluje u sebe a data má pod kontrolou.
- **Bezpečné už návrhem.** Platforma kód appek nespouští, jen ho servíruje. Backend tvoří naše ověřené bloky.
- **Jednoduché.** Jeden kontejner, běží na obyčejném serveru.
- **Funguje s jakýmkoliv AI agentem.** Neplatíš za našeho agenta.

## Trh

Stejný princip právě spustilo Macaly (team.blue). Je ale uzavřené a jde provozovat jen u nich. **Open-source ani self-hosted verzi tohohle zatím nikdo nemá.** Cílovka: firmy a lidé, kteří chtějí interní appky a nástroje na vlastním serveru.

## Model

- **drobek:** open source, zdarma pro vlastní instalaci.
- **drobek.app:** hostovaná placená verze pro ty, kdo nechtějí řešit server.
