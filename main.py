"""Fotbalové tipy – vstupní bod aplikace.

    python main.py          spustí okno aplikace
    python main.py --cli    jen stáhne tipy a vypíše je do konzole (bez GUI; hodí se k ladění)
"""
from __future__ import annotations

import argparse
import logging
import logging.handlers
import sys

from tipster import config


def _setup_logging(verbose: bool) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        logging.handlers.RotatingFileHandler(config.LOG_PATH, maxBytes=500_000, backupCount=2, encoding="utf-8")]
    if verbose:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO, handlers=handlers,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("selenium", "urllib3", "asyncio"):      # cizí knihovny logují i celé HTML stránek
        logging.getLogger(noisy).setLevel(logging.WARNING)


def run_cli(save: bool) -> int:
    from tipster.database import Database
    from tipster.odds import fmt_odds
    from tipster.pipeline import Pipeline
    from tipster.timeutil import fmt_kickoff

    result = Pipeline().run(progress=lambda m: print("·", m, flush=True))
    print()
    for st in result.statuses.values():
        print(f"{st.name:10} {st.state:8} {st.message}")
    print()
    for t in result.tips:
        print(f"{fmt_kickoff(t.kickoff_utc):14} {t.match_name[:38]:38} {t.league[:24]:24} {t.tip_label[:32]:32} "
              f"{t.probability:5.0f} % {fmt_odds(t.odds, t.odds_estimated):>6}  {t.source_label}"
              f"{'  [' + t.status + ']' if t.status != 'upcoming' else ''}")
    print(f"\nNalezeno tipů po filtraci: {len(result.tips)}")
    if save and result.success:
        run_id = Database().save_run(result)
        print(f"Uloženo do databáze {config.DB_PATH} (běh {run_id}).")
    return 0 if result.success else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Fotbalové tipy")
    ap.add_argument("--cli", action="store_true", help="stáhnout a vypsat tipy do konzole bez okna")
    ap.add_argument("--save", action="store_true", help="u --cli uložit výsledek do databáze")
    ap.add_argument("-v", "--verbose", action="store_true", help="podrobný log na konzoli")
    args = ap.parse_args(argv)
    _setup_logging(args.verbose)
    if args.cli:
        return run_cli(args.save)
    from tipster.ui import run_app
    run_app()
    return 0


if __name__ == "__main__":
    sys.exit(main())
