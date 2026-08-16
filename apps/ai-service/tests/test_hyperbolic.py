"""Correctness tests for the Poincaré-ball scope baseline.

This module is listed in configs/c1_rules.json as a pre-registered baseline
("poincare_hyperbolic_distance") but had no importer, no route and no test — a
pre-registered baseline that has never been executed is the first thing a
reviewer asks about.

Running it *as a baseline* is blocked on the T2 labelled set, which does not
exist. What is not blocked is checking that the implementation computes what it
claims to: the geodesic distance has closed-form values and metric-space
properties that can be verified without a single label. That is what these
tests do, so that when T2 lands the baseline can be run rather than debugged.

They also pin the projection behaviour that the module's docstring flags as a
methodological caveat, so the caveat cannot quietly stop being true.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from app.services.hyperbolic import hyperbolic_scope_check, poincare_geodesic_distance
from app.utils.vector_ops import project_to_poincare_ball


class TestGeodesicDistanceIsAMetric:
    """d_H must satisfy the metric axioms; a failure here invalidates any use."""

    def test_distance_from_a_point_to_itself_is_zero(self):
        u = np.array([0.1, 0.2, 0.3])
        assert poincare_geodesic_distance(u, u) == pytest.approx(0.0, abs=1e-9)

    def test_distance_is_symmetric(self):
        u = np.array([0.1, 0.2, 0.3])
        v = np.array([-0.4, 0.05, 0.2])
        assert poincare_geodesic_distance(u, v) == pytest.approx(
            poincare_geodesic_distance(v, u), abs=1e-12
        )

    def test_distance_between_distinct_points_is_positive(self):
        u = np.array([0.1, 0.0, 0.0])
        v = np.array([0.2, 0.0, 0.0])
        assert poincare_geodesic_distance(u, v) > 0.0

    def test_triangle_inequality_holds_on_random_interior_points(self):
        rng = np.random.default_rng(1729)
        for _ in range(200):
            # Sampled well inside the ball so no clamping occurs and the axiom
            # is tested against the formula rather than against the projection.
            pts = rng.uniform(-0.4, 0.4, size=(3, 8))
            a, b, c = pts
            ab = poincare_geodesic_distance(a, b)
            bc = poincare_geodesic_distance(b, c)
            ac = poincare_geodesic_distance(a, c)
            assert ac <= ab + bc + 1e-9


class TestGeodesicDistanceClosedForm:
    """Checks against values the Poincaré metric has in closed form."""

    def test_distance_from_the_origin_equals_two_artanh_of_the_norm(self):
        # d_H(0, x) = 2 artanh(||x||) is the standard radial identity.
        origin = np.zeros(4)
        for r in (0.1, 0.25, 0.5, 0.75, 0.9):
            v = np.array([r, 0.0, 0.0, 0.0])
            expected = 2.0 * math.atanh(r)
            assert poincare_geodesic_distance(origin, v) == pytest.approx(expected, rel=1e-9)

    def test_the_radial_half_point_matches_ln_three(self):
        # A concrete anchor: 2 artanh(0.5) = ln 3. If the arcosh argument is
        # ever rearranged, this catches an algebra slip that the relative-
        # tolerance test above could absorb.
        origin = np.zeros(3)
        v = np.array([0.5, 0.0, 0.0])
        assert poincare_geodesic_distance(origin, v) == pytest.approx(math.log(3.0), rel=1e-12)

    def test_distance_grows_without_bound_toward_the_boundary(self):
        # Hyperbolic space is infinite in extent: as ||v|| -> 1 the distance
        # from the origin diverges. Euclidean distance would stay bounded by 1,
        # so this is the property that distinguishes the two.
        origin = np.zeros(3)
        near = poincare_geodesic_distance(origin, np.array([0.9, 0.0, 0.0]))
        nearer = poincare_geodesic_distance(origin, np.array([0.99, 0.0, 0.0]))
        assert nearer > near > 0
        assert nearer > 5.0

    def test_distance_is_monotone_in_euclidean_separation_along_a_ray(self):
        origin = np.zeros(3)
        prev = -1.0
        for r in (0.1, 0.2, 0.3, 0.4, 0.5, 0.6):
            d = poincare_geodesic_distance(origin, np.array([r, 0.0, 0.0]))
            assert d > prev
            prev = d


class TestNumericalGuards:
    """The clamps that keep arcosh in its domain must not mask real values."""

    def test_identical_unit_vectors_do_not_produce_nan(self):
        # Both clamp to norm 0.999, so the denominator is ~4e-6; without the
        # `max(1.0, arg)` guard floating error can push the argument below 1
        # and arccosh returns nan.
        u = np.array([1.0, 0.0, 0.0])
        d = poincare_geodesic_distance(u, u)
        assert not math.isnan(d)
        assert d == pytest.approx(0.0, abs=1e-6)

    def test_zero_vectors_are_handled(self):
        z = np.zeros(5)
        assert poincare_geodesic_distance(z, z) == pytest.approx(0.0, abs=1e-12)

    def test_large_magnitude_inputs_stay_finite(self):
        u = np.array([1000.0, -500.0, 250.0])
        v = np.array([-800.0, 300.0, 100.0])
        d = poincare_geodesic_distance(u, v)
        assert math.isfinite(d)
        assert d >= 0.0


class TestProjectionCaveat:
    """Pins the behaviour the module docstring warns about.

    These are not aspirational tests — they assert the current, documented
    limitation, so that if someone fixes the projection the tests fail and the
    docstring gets updated with it rather than going stale.
    """

    def test_unit_norm_embeddings_are_all_clamped_to_the_same_shell(self):
        # Sentence-transformer output is L2-normalised, so this is the shape of
        # every real input to this baseline.
        rng = np.random.default_rng(7)
        for _ in range(20):
            v = rng.normal(size=16)
            v = v / np.linalg.norm(v)
            projected = project_to_poincare_ball(v)
            assert np.linalg.norm(projected) == pytest.approx(0.999, abs=1e-9)

    def test_projection_leaves_interior_points_untouched(self):
        v = np.array([0.1, 0.2, 0.05])
        assert np.allclose(project_to_poincare_ball(v), v)

    def test_projection_preserves_direction_when_it_clamps(self):
        v = np.array([3.0, 4.0, 0.0])  # norm 5
        projected = project_to_poincare_ball(v)
        assert np.linalg.norm(projected) == pytest.approx(0.999, abs=1e-9)
        # Same ray: the normalised vectors agree.
        assert np.allclose(projected / np.linalg.norm(projected), v / np.linalg.norm(v))

    def test_projection_maps_the_zero_vector_to_itself(self):
        z = np.zeros(4)
        assert np.allclose(project_to_poincare_ball(z), z)


class TestHyperbolicScopeCheck:
    """The baseline's decision wrapper."""

    def test_no_requirements_allows_by_default(self):
        # Mirrors how the shipped guard treats an unmeasured scope term as
        # neutral. A baseline that failed closed here would not be comparable.
        result = hyperbolic_scope_check(np.array([0.5, 0.5]), [])
        assert result["allowed"] is True
        assert result["min_geodesic_distance"] == 0.0

    def test_a_message_identical_to_a_requirement_is_in_scope(self):
        vec = np.array([0.2, 0.3, 0.1])
        result = hyperbolic_scope_check(vec, [vec])
        assert result["allowed"] is True
        assert result["min_geodesic_distance"] == pytest.approx(0.0, abs=1e-4)

    def test_it_takes_the_minimum_across_requirements_not_the_mean(self):
        # One close requirement is enough to be in scope, however far the others
        # are — the same "closest requirement wins" rule the real guard uses.
        message = np.array([0.2, 0.0, 0.0])
        near = np.array([0.21, 0.0, 0.0])
        far = np.array([0.0, 0.0, 0.95])
        result = hyperbolic_scope_check(message, [far, near])
        solo = poincare_geodesic_distance(message, near)
        assert result["min_geodesic_distance"] == pytest.approx(round(solo, 4), abs=1e-4)

    def test_threshold_is_respected_in_both_directions(self):
        message = np.array([0.1, 0.0, 0.0])
        requirement = np.array([0.6, 0.0, 0.0])
        d = poincare_geodesic_distance(message, requirement)

        assert hyperbolic_scope_check(message, [requirement], threshold=d + 0.1)["allowed"] is True
        assert hyperbolic_scope_check(message, [requirement], threshold=d - 0.1)["allowed"] is False

    def test_the_threshold_is_echoed_back_for_auditability(self):
        result = hyperbolic_scope_check(np.array([0.1, 0.0]), [np.array([0.2, 0.0])], threshold=1.5)
        assert result["threshold"] == 1.5

    def test_default_threshold_is_the_documented_placeholder(self):
        # 2.5 was never fit on data. This test exists so that when the threshold
        # is selected on T2, the change is deliberate and visible in a diff
        # rather than an unremarked constant edit.
        result = hyperbolic_scope_check(np.array([0.1, 0.0]), [np.array([0.2, 0.0])])
        assert result["threshold"] == 2.5
