#include <cmath>
#include <iostream>
using namespace std;

int main() {
    int q;
    cin >> q;
    while (q--) {
        long long a, b, m;
        cin >> a >> b >> m;
        long long ans = (long long)std::pow((double)a, (double)b) % m;
        cout << ans << "\n";
    }
    return 0;
}
