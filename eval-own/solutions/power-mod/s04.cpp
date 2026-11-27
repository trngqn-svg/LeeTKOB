#include <cmath>
#include <iostream>
#define CALC_POW(x, y) std::pow((double)(x), (double)(y))
using namespace std;

int main() {
    int q;
    cin >> q;
    while (q--) {
        long long a, b, m;
        cin >> a >> b >> m;
        long long ans = (long long)CALC_POW(a, b) % m;
        cout << ans << "\n";
    }
    return 0;
}
