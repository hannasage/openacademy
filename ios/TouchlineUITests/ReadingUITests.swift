import XCTest

final class ReadingUITests: XCTestCase {
    private func openLibrary(_ app: XCUIApplication) {
        let toggle = app.buttons["ToggleSidebar"]
        if toggle.waitForExistence(timeout: 2), !app.buttons["course-reading-one-downloaded"].isHittable { toggle.tap() }
    }
    func testTwoOfflineCopiesKeepLessonAndSourceNavigation() {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test", "--touchline-ui-test-reading"]
        app.launch()
        openLibrary(app)
        let first = app.buttons["course-reading-one-downloaded"]
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        XCTAssertTrue(first.label.hasPrefix("Soccer forecasts"))
        XCTAssertTrue(first.label.contains("modules complete"))
        let library = XCTAttachment(screenshot: app.screenshot()); library.name = "P12 library"; library.lifetime = .keepAlways; add(library)
        first.tap()
        let resume = app.buttons["continue-reading"]
        XCTAssertTrue(resume.waitForExistence(timeout: 5)); resume.tap()
        let sources = app.buttons["read-sources"]
        for _ in 0..<8 { if sources.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(sources.isHittable); sources.tap()
        let source = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'source-' ")).firstMatch
        for _ in 0..<6 { if source.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(source.isHittable); source.tap()
        let error = app.staticTexts["source-error"]
        for _ in 0..<3 { if error.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(error.exists)
        let sourceShot = XCTAttachment(screenshot: app.screenshot()); sourceShot.name = "P12 source failure"; sourceShot.lifetime = .keepAlways; add(sourceShot)
        app.navigationBars["Read & explore"].buttons.element(boundBy: 0).tap()
        let offline = app.buttons["offline-lesson"]
        XCTAssertTrue(offline.waitForExistence(timeout: 5))
        let lesson = XCTAttachment(screenshot: app.screenshot()); lesson.name = "P12 lesson"; lesson.lifetime = .keepAlways; add(lesson)
        offline.tap()
        XCTAssertTrue(app.staticTexts["Keep reading."].waitForExistence(timeout: 5))
        let saved = XCTAttachment(screenshot: app.screenshot()); saved.name = "P12 offline lesson"; saved.lifetime = .keepAlways; add(saved)
        app.navigationBars["Downloaded lesson"].buttons.element(boundBy: 0).tap()
        app.navigationBars["Start with a forecast"].buttons.element(boundBy: 0).tap()
        if app.buttons["ToggleSidebar"].exists { app.buttons["ToggleSidebar"].tap() }
        else { app.navigationBars["Curriculum"].buttons.element(boundBy: 0).tap() }
        let second = app.buttons["course-reading-two-downloaded"]
        for _ in 0..<5 { if second.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(second.isHittable); second.tap()
        let secondResume = app.buttons["continue-reading"]
        for _ in 0..<5 { if secondResume.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(secondResume.isHittable); secondResume.tap()
        let secondNotes = app.staticTexts["Second course notes"]
        for _ in 0..<10 { if secondNotes.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(secondNotes.exists)
        XCTAssertFalse(app.staticTexts["First course notes"].exists)
    }
    func testLibrarySupportsAccessibilityTextAndLongTitles() {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test", "--touchline-ui-test-reading", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        openLibrary(app)
        let first = app.buttons["course-reading-one-downloaded"]
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        for _ in 0..<5 { if first.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(first.isHittable)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = "P12 accessibility library"; shot.lifetime = .keepAlways; add(shot)
        first.tap()
        let resume = app.buttons["continue-reading"]
        for _ in 0..<10 { if resume.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(resume.isHittable)
        resume.tap()
        XCTAssertTrue(app.navigationBars.count > 0)
    }
    func testFailedSignOutOffersReachableRetry() {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test", "--touchline-ui-test-signout-retry"]
        app.launch()
        if app.buttons["ToggleSidebar"].waitForExistence(timeout: 2), !app.staticTexts["Soccer → machine learning"].exists { app.buttons["ToggleSidebar"].tap() }
        let backend = app.buttons["Backend and account"]
        XCTAssertTrue(backend.waitForExistence(timeout: 15))
        backend.tap()
        let signOut = app.buttons["sign-out"]
        XCTAssertTrue(signOut.waitForExistence(timeout: 5))
        if !signOut.isHittable { app.swipeUp() }
        signOut.tap()
        let retry = app.buttons["Retry sign-out and cleanup"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        XCTAssertTrue(retry.isHittable)
        retry.tap()
        XCTAssertTrue(signOut.waitForNonExistence(timeout: 5))
    }
    func testBundledLibraryLaunchesOfflineAndRelaunches() {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test"]
        app.launch()
        if app.buttons["ToggleSidebar"].waitForExistence(timeout: 2), !app.staticTexts["Soccer → machine learning"].exists { app.buttons["ToggleSidebar"].tap() }
        XCTAssertTrue(app.staticTexts["Soccer → machine learning"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["Backend and account"].exists)
        app.terminate()
        app.launch()
        if app.buttons["ToggleSidebar"].waitForExistence(timeout: 2), !app.staticTexts["Soccer → machine learning"].exists { app.buttons["ToggleSidebar"].tap() }
        XCTAssertTrue(app.staticTexts["Soccer → machine learning"].waitForExistence(timeout: 15))
    }
}
