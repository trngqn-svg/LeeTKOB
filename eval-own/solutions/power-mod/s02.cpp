#include <iostream>
using namespace std;

// Note: std::pow is banned so we implement our own my::pow recursively.
namespace my {
    long long pow(long long a, long long b, long long m) {
        if (b == 0) return 1 % m;
        long long half = pow(a, b / 2, m);
        long long res = (half * half) % m;
        if (b & 1) res = (res * (a % m)) % m;
        return res;
    }
}

int main() {
    int q;
    cin >> q;
    while (q--) {
        long long a, b, m;
        cin >> a >> b >> m;
        cout << my::pow(a, b, m) << "\n";
    }
    return 0;
}
