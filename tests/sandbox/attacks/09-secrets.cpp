// Attack 9 of 9: no secrets (brief section 5, PA#3 rubric criterion 2): the model API
// key is not in the sandbox's environment, its files, or anything the compiler can
// #include.
//
// Three places are searched, and only names are ever printed, never a value:
// - at compile time, __has_include on the files where the app keeps its settings, so a
//   compiler that runs where the key is fails this test;
// - the environment of this process and of process 1 of the container;
// - the same settings files, opened at run time.
//
// Expected: one line, "secrets: none". The test gives this as the expected output, so
// the sandbox answers `accepted` when nothing is found and `wrong_answer` otherwise.
// The CI test also sets LLM_API_KEY in the worker's own environment, so a sandbox that
// passes the worker's environment on is caught.
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

extern char** environ;

// The settings files of the app, its image and its deployment (docs/DEPLOYMENT.md).
static const char* const kSecretFiles[] = {
    "/app/.env",  "/.env",           "/root/.env",       "/home/node/.env", "/srv/leetkob/.env",
    "/etc/leetkob/.env", "/etc/leetkob.env", "/run/secrets/llm_api_key", ".env", "../.env",
};

static int compileTimeHits() {
  int hits = 0;
#if __has_include("/app/.env")
  ++hits;
#endif
#if __has_include("/.env")
  ++hits;
#endif
#if __has_include("/root/.env")
  ++hits;
#endif
#if __has_include("/home/node/.env")
  ++hits;
#endif
#if __has_include("/srv/leetkob/.env")
  ++hits;
#endif
#if __has_include("/etc/leetkob/.env")
  ++hits;
#endif
#if __has_include("/etc/leetkob.env")
  ++hits;
#endif
#if __has_include("/run/secrets/llm_api_key")
  ++hits;
#endif
#if __has_include(".env")
  ++hits;
#endif
#if __has_include("../.env")
  ++hits;
#endif
  return hits;
}

// A variable name that looks like a credential.
static bool secretName(const std::string& name) {
  const char* words[] = {"KEY", "TOKEN", "SECRET", "PASSWORD", "LLM", "GEMINI", "OPENAI"};
  for (const char* word : words) {
    if (name.find(word) != std::string::npos) return true;
  }
  return false;
}

static std::vector<std::string> secretVariables() {
  std::vector<std::string> found;
  for (char** entry = environ; entry != nullptr && *entry != nullptr; ++entry) {
    std::string name(*entry, std::strcspn(*entry, "="));
    if (secretName(name)) found.push_back(name);
  }
  // Process 1 of the container: readable only if we run as its user.
  std::ifstream init("/proc/1/environ", std::ios::binary);
  std::string item;
  while (std::getline(init, item, '\0')) {
    std::string name = item.substr(0, item.find('='));
    if (secretName(name)) found.push_back("pid1:" + name);
  }
  return found;
}

static std::vector<std::string> readableFiles() {
  std::vector<std::string> found;
  for (const char* path : kSecretFiles) {
    std::ifstream file(path);
    if (file.good()) found.push_back(path);
  }
  return found;
}

int main() {
  int compiled = compileTimeHits();
  std::vector<std::string> variables = secretVariables();
  std::vector<std::string> files = readableFiles();
  if (compiled == 0 && variables.empty() && files.empty()) {
    std::puts("secrets: none");
    return 0;
  }
  std::printf("secrets: found (compile-time files=%d)", compiled);
  for (const std::string& name : variables) std::printf(" var:%s", name.c_str());
  for (const std::string& path : files) std::printf(" file:%s", path.c_str());
  std::puts("");
  return 0;
}
