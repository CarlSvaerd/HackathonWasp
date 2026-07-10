from src.calculator import Calculator, add


def test_add_returns_sum():
    assert add(2, 3) == 5


class TestCalculator:
    def test_multiply_returns_product(self):
        assert Calculator().multiply(3, 4) == 12
