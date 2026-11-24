import json
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

DATA_PATH = PROJECT_ROOT / "web" / "data" / "data.json"
DATA_JS_PATH = PROJECT_ROOT / "web" / "data" / "data.js"


class PreparedDataTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        cls.meta = cls.payload["meta"]
        cls.cells = cls.payload["cells"]
        cls.scenarios = cls.meta["scenarios"]
        cls.scenario_keys = [scenario["key"] for scenario in cls.scenarios]
        cls.norm_codes = cls.meta["codes"]["norm"]
        cls.status_codes = cls.meta["codes"]["status"]

    def record(self, cell, key):
        index = self.scenario_keys.index(key)
        return cell["s"][index]

    def test_grid_and_boundary(self):
        grid = self.meta["grid"]
        self.assertEqual(grid["rows"], 94)
        self.assertEqual(grid["columns"], 73)
        self.assertEqual(grid["cell_size_m"], 500.0)
        self.assertEqual(grid["cell_count"], 3468)
        self.assertEqual(grid["boundary_cell_count"], 362)
        self.assertAlmostEqual(grid["territory_area_km2"], 822.065118, places=6)
        self.assertEqual(len(self.cells), 3468)
        self.assertEqual(len(self.meta["boundary"]), 1)
        self.assertEqual(self.meta["boundary_meta"]["display_point_count"], 462)
        self.assertEqual(self.meta["boundary_meta"]["source_point_count"], 1548)
        self.assertAlmostEqual(
            self.meta["boundary_meta"]["area_km2"], 822.065118, places=6
        )

    def test_cells_are_complete_and_unique(self):
        ids = [cell["id"] for cell in self.cells]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(self.scenarios), 4)
        self.assertEqual(
            {scenario["key"] for scenario in self.scenarios},
            {
                "housing",
                "industrial",
                "recreation_tourism",
                "transport_infrastructure",
            },
        )
        for cell in self.cells:
            self.assertRegex(cell["id"], r"^r\d{6}_c\d{6}$")
            self.assertTrue(1 <= cell["r"] <= 94)
            self.assertTrue(1 <= cell["c"] <= 73)
            self.assertTrue(0.0 <= cell["in"] <= 1.0)
            self.assertIn(cell["b"], (0, 1))
            self.assertEqual(len(cell["k"]), 4)
            self.assertEqual(len(cell["v"]), 2)
            self.assertIn(cell["ls"], {"complete", "partial", "not_available"})
            self.assertEqual(len(cell["s"]), 4)
            for record in cell["s"]:
                self.assertEqual(len(record), 16)
                self.assertIn(record[0], self.norm_codes.values())
                self.assertIn(record[1], self.norm_codes.values())
                self.assertIn(record[10], self.meta["codes"]["mode"].values())
                self.assertIn(record[11], self.status_codes.values())

    def test_physical_bank_matches_status(self):
        complete = sum(1 for cell in self.cells if cell["ls"] == "complete")
        partial = sum(1 for cell in self.cells if cell["ls"] == "partial")
        missing = sum(1 for cell in self.cells if cell["ls"] == "not_available")
        self.assertEqual(complete, 3423)
        self.assertEqual(partial, 11)
        self.assertEqual(missing, 34)
        for cell in self.cells:
            if cell["ls"] == "complete":
                self.assertTrue(all(value is not None for value in cell["k"]))
            if cell["ls"] == "not_available":
                self.assertTrue(all(value is None for value in cell["k"]))

    def test_saved_index_only_for_calculated_cells(self):
        calculated_status = self.status_codes["calculated"]
        for cell in self.cells:
            for record in cell["s"]:
                if record[11] == calculated_status:
                    self.assertIsNotNone(record[8])
                    self.assertIsNotNone(record[9])
                    self.assertIsNotNone(record[12])
                else:
                    self.assertIsNone(record[8])
                    self.assertIsNone(record[12])

    def test_prohibited_and_review_cells(self):
        prohibited = self.norm_codes["prohibited"]
        unclassified = self.norm_codes["unclassified"]
        for key in ("housing", "recreation_tourism"):
            rows = [self.record(cell, key) for cell in self.cells]
            r3 = [row for row in rows if row[0] == prohibited]
            self.assertEqual(len(r3), 12)
            self.assertEqual(sum(1 for row in r3 if row[2] == 1.0), 1)
            self.assertTrue(all(row[2] > 0.0 for row in r3))
        for key in ("industrial", "transport_infrastructure"):
            rows = [self.record(cell, key) for cell in self.cells]
            self.assertEqual(sum(1 for row in rows if row[0] == prohibited), 0)

        for key in self.scenario_keys:
            review_cells = [
                cell
                for cell in self.cells
                if self.record(cell, key)[0] == unclassified
            ]
            self.assertEqual(len(review_cells), 34)
            for cell in review_cells:
                self.assertEqual(cell["ls"], "not_available")
                self.assertTrue(all(value is None for value in cell["k"]))
                self.assertIsNone(self.record(cell, key)[8])

    def test_overlapping_normative_shares_are_preserved(self):
        overlapping = []
        for cell in self.cells:
            for key in self.scenario_keys:
                record = self.record(cell, key)
                total = sum(record[2:8])
                self.assertTrue(all(0.0 <= value <= 1.0 for value in record[2:8]))
                if total > 1.000001:
                    overlapping.append((cell, key, record, total))
        self.assertTrue(overlapping)
        self.assertLessEqual(max(item[3] for item in overlapping), 2.0 + 1e-6)
        for _, _, record, _ in overlapping:
            self.assertEqual(record[0], self.norm_codes["unclassified"])

    def test_scenario_statistics(self):
        expected = {
            "housing": {
                "calculated": 3411,
                "excluded": 12,
                "review": 34,
                "missing": 11,
                "preservation": 3206,
                "limited": 194,
                "extensive": 11,
                "intensive": 0,
            },
            "industrial": {
                "calculated": 3423,
                "excluded": 0,
                "review": 34,
                "missing": 11,
                "preservation": 3097,
                "limited": 325,
                "extensive": 0,
                "intensive": 1,
            },
            "recreation_tourism": {
                "calculated": 3411,
                "excluded": 12,
                "review": 34,
                "missing": 11,
                "preservation": 3219,
                "limited": 190,
                "extensive": 2,
                "intensive": 0,
            },
            "transport_infrastructure": {
                "calculated": 3423,
                "excluded": 0,
                "review": 34,
                "missing": 11,
                "preservation": 3210,
                "limited": 210,
                "extensive": 3,
                "intensive": 0,
            },
        }
        for scenario in self.scenarios:
            stats = scenario["stats"]
            item = expected[scenario["key"]]
            self.assertEqual(stats["calculated"], item["calculated"])
            self.assertEqual(stats["excluded"], item["excluded"])
            self.assertEqual(stats["review"], item["review"])
            self.assertEqual(stats["missing"], item["missing"])
            self.assertEqual(
                stats["recommended_counts"].get("preservation", 0),
                item["preservation"],
            )
            self.assertEqual(
                stats["recommended_counts"].get("limited_development", 0),
                item["limited"],
            )
            self.assertEqual(
                stats["recommended_counts"].get("extensive_development", 0),
                item["extensive"],
            )
            self.assertEqual(
                stats["recommended_counts"].get("intensive_development", 0),
                item["intensive"],
            )
            self.assertEqual(
                stats["calculated"]
                + stats["excluded"]
                + stats["review"]
                + stats["missing"],
                3468,
            )

    def test_experiment_counts_and_ranking(self):
        experiment = self.payload["experiment"]
        self.assertEqual(set(experiment["definitions"]), {"A", "B", "C", "D"})
        expected_candidates = {
            "housing": (3423, 3411, 3411),
            "industrial": (3423, 3423, 3423),
            "recreation_tourism": (3423, 3411, 3411),
            "transport_infrastructure": (3423, 3423, 3423),
        }
        for key, candidates in expected_candidates.items():
            scenario = experiment["scenarios"][key]
            self.assertEqual(
                tuple(scenario[name]["candidate_count"] for name in ("A", "B", "C")),
                candidates,
            )
            self.assertEqual(len(scenario["C"]["top"]), 10)
            self.assertEqual(
                len({item["cell_id"] for item in scenario["C"]["top"]}), 10
            )
            self.assertEqual(scenario["C"]["flagged_review_total"], 34)
            self.assertEqual(scenario["C"]["flagged_review_with_diagnostics"], 0)
        self.assertEqual(
            experiment["scenarios"]["housing"]["C"]["top"][0]["cell_id"],
            "r000087_c000050",
        )
        self.assertEqual(
            experiment["scenarios"]["industrial"]["C"]["top"][0]["cell_id"],
            "r000053_c000052",
        )

    def test_cross_scenario_metrics(self):
        cross = self.payload["experiment"]["cross_scenario"]
        self.assertEqual(cross["conflict_count"], 406)
        self.assertEqual(cross["development_conflict_count"], 10)
        self.assertEqual(cross["preservation_vs_development_count"], 391)
        self.assertEqual(cross["top10_all_count"], 2)
        self.assertEqual(cross["top10_unique_count"], 6)
        self.assertEqual(len(cross["conflict_examples"]), 12)
        self.assertEqual(cross["conflict_examples_total"], 406)
        for key in self.scenario_keys:
            self.assertEqual(cross["top10_overlap_jaccard"][key][key], 1.0)

    def test_zone_sources_and_synthetic_check(self):
        self.assertEqual(len(self.meta["zone_sources"]), 312)
        self.assertEqual(
            len({key.split("__", 1)[0] for key in self.meta["zone_sources"]}), 78
        )
        self.assertEqual(
            self.meta["data_quality"]["normative_report"]["input_zone_count"], 78
        )
        self.assertIsNotNone(self.payload["synthetic_check"])
        rows = self.payload["synthetic_check"]["rows"]
        self.assertEqual([row["cell"] for row in rows], ["A", "B", "C", "D", "E"])
        self.assertAlmostEqual(
            rows[0]["scenarios"]["housing"]["si"],
            0.17021887588836299,
            places=12,
        )

    def test_data_js_wraps_same_payload(self):
        text = DATA_JS_PATH.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("window.LANDSCAPE_DATA="))
        self.assertTrue(text.rstrip().endswith(";"))


if __name__ == "__main__":
    unittest.main()
