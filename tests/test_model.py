import json
import sys
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from landscape_planning.model import (  # noqa: E402
    classify_landscape,
    combine_mode,
    effective_norm_status,
    expected_scenario_status,
    mode_counts,
    normalize,
    weighted_index,
)


class ModelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads(
            (PROJECT_ROOT / "config" / "scenarios.json").read_text(encoding="utf-8")
        )
        cls.criteria = cls.config["criteria"]
        cls.scenarios = {
            scenario["key"]: scenario for scenario in cls.config["scenarios"]
        }

    def test_normalize_direct_and_inverse(self):
        self.assertAlmostEqual(normalize(10, 0, 20, "direct"), 0.5)
        self.assertAlmostEqual(normalize(500, 0, 1000, "inverse"), 0.5)
        self.assertEqual(normalize(-5, 0, 20, "direct"), 0.0)
        self.assertEqual(normalize(25, 0, 20, "direct"), 1.0)
        self.assertEqual(normalize(1200, 0, 1000, "inverse"), 0.0)

    def test_normalize_rejects_unknown_direction_and_bad_bounds(self):
        with self.assertRaises(ValueError):
            normalize(1, 0, 10, "sideways")
        with self.assertRaises(ValueError):
            normalize(1, 10, 10, "direct")

    def test_weighted_index_reproduces_synthetic_cell_a(self):
        expected = {
            "housing": 0.17021887588836299,
            "industrial": 0.32841500131609325,
            "recreation_tourism": 0.3618728779941122,
            "transport_infrastructure": 0.24903303280463518,
        }
        values = [2.0, 268.343741774417, 0.2, 50.0]
        for key, scenario in self.scenarios.items():
            normalized, index = weighted_index(
                values,
                scenario["weights"],
                self.criteria,
                development_direction=scenario["development_direction"],
            )
            self.assertEqual(len(normalized), 4)
            self.assertTrue(all(0.0 <= value <= 1.0 for value in normalized))
            self.assertAlmostEqual(index, expected[key], places=12)

    def test_classification_uses_inclusive_upper_bounds(self):
        self.assertEqual(classify_landscape(0.0), "intensive_development")
        self.assertEqual(classify_landscape(0.25), "intensive_development")
        self.assertEqual(classify_landscape(0.2500001), "extensive_development")
        self.assertEqual(classify_landscape(0.50), "extensive_development")
        self.assertEqual(classify_landscape(0.5000001), "limited_development")
        self.assertEqual(classify_landscape(0.75), "limited_development")
        self.assertEqual(classify_landscape(0.7500001), "preservation")

    def test_combine_mode_preserves_conditional_preservation(self):
        self.assertEqual(
            combine_mode("no_known_restrictions", "intensive_development"),
            "intensive_development",
        )
        self.assertEqual(
            combine_mode("allowed", "extensive_development"),
            "extensive_development",
        )
        self.assertEqual(
            combine_mode("conditional", "intensive_development"),
            "limited_development",
        )
        self.assertEqual(
            combine_mode("conditional", "preservation"),
            "preservation",
        )
        with self.assertRaises(ValueError):
            combine_mode("prohibited", "intensive_development")

    def test_effective_status_priority_and_any_prohibited_share(self):
        self.assertEqual(
            effective_norm_status(
                "conditional",
                prohibited_share=0.001,
                unclassified_share=0.0,
                not_assessed_share=0.0,
            ),
            "prohibited",
        )
        self.assertEqual(
            effective_norm_status(
                "no_known_restrictions",
                prohibited_share=0.0,
                unclassified_share=0.2,
                not_assessed_share=0.0,
            ),
            "unclassified",
        )
        self.assertEqual(
            effective_norm_status(
                "no_known_restrictions",
                prohibited_share=0.0,
                unclassified_share=0.0,
                not_assessed_share=0.2,
            ),
            "not_assessed",
        )
        self.assertEqual(
            effective_norm_status(
                "conditional",
                prohibited_share=0.0,
                unclassified_share=0.0,
                not_assessed_share=0.0,
            ),
            "conditional",
        )
        self.assertEqual(
            effective_norm_status(
                "unexpected",
                prohibited_share=0.0,
                unclassified_share=0.0,
                not_assessed_share=0.0,
            ),
            "unclassified",
        )

    def test_expected_scenario_status(self):
        common = {
            "prohibited_share": 0.0,
            "unclassified_share": 0.0,
            "not_assessed_share": 0.0,
            "has_all_criteria": True,
        }
        self.assertEqual(
            expected_scenario_status("conditional", **common), "calculated"
        )
        self.assertEqual(
            expected_scenario_status("prohibited", **common),
            "normatively_prohibited",
        )
        self.assertEqual(
            expected_scenario_status("unclassified", **common),
            "normative_review_required",
        )
        self.assertEqual(
            expected_scenario_status("not_assessed", **common),
            "normative_data_missing",
        )
        self.assertEqual(
            expected_scenario_status(
                "conditional", **{**common, "has_all_criteria": False}
            ),
            "landscape_data_missing",
        )

    def test_mode_counts(self):
        self.assertEqual(
            mode_counts(["preservation", "preservation", "limited_development"]),
            {"preservation": 2, "limited_development": 1},
        )


if __name__ == "__main__":
    unittest.main()
